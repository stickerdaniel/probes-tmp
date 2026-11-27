use crate::generated::*;
use jsonrpsee_core::server::RpcModule;
use jsonrpsee_types::ErrorObjectOwned;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub enum Method {
    #[serde(rename = "autostart.show")]
    AutostartShow,
    #[serde(rename = "autostart.set")]
    AutostartSet,
    #[serde(rename = "sample.optional")]
    SampleOptional,
    #[serde(rename = "sample.nullable")]
    SampleNullable,
}

#[derive(Deserialize, Serialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub method: Method,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Serialize)]
pub struct Dispatch {
    method: Method,
    params: Value,
    outcome: &'static str,
}

pub type Dispatches = Arc<Mutex<Vec<Dispatch>>>;

struct InvalidParams;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Reply {
    Result(Value),
    Error(WireError),
}

#[derive(Serialize)]
struct WireError {
    #[serde(rename = "_tag", skip_serializing_if = "Option::is_none")]
    tag: Option<&'static str>,
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

impl WireError {
    fn refusal(cause: Value, marked: bool) -> Self {
        Self {
            tag: marked.then_some("Cause"),
            code: 0,
            message: cause.to_string(),
            data: Some(cause),
        }
    }

    fn invalid_params() -> Self {
        Self {
            tag: None,
            code: -32602,
            message: "Invalid params".into(),
            data: None,
        }
    }
}

#[derive(Serialize)]
struct Response {
    jsonrpc: &'static str,
    id: u64,
    #[serde(flatten)]
    reply: Reply,
}

fn parse<T: DeserializeOwned>(params: &Value) -> Result<T, InvalidParams> {
    serde_json::from_value(params.clone()).map_err(|_| InvalidParams)
}

fn encode<T: Serialize, E: Serialize>(value: Result<T, E>) -> Result<Value, Value> {
    value
        .map(|value| serde_json::to_value(value).unwrap())
        .map_err(|cause| serde_json::to_value(cause).unwrap())
}

fn call(
    method: Method,
    params: &Value,
    refuse: bool,
) -> Result<Result<Value, Value>, InvalidParams> {
    Ok(match method {
        Method::AutostartShow => {
            let _: AutostartShowParams = parse(params)?;
            encode(if refuse {
                Err(AutostartShowCause(vec![AutostartShowCauseItem::Fail {
                    error: AutostartShowCauseItemError::SettingRefused("locked".into()),
                }]))
            } else {
                Ok(AutostartShowResult { enabled: false })
            })
        }
        Method::AutostartSet => {
            let input: AutostartSetParams = parse(params)?;
            encode(if refuse {
                Err(AutostartSetCause(vec![AutostartSetCauseItem::Fail {
                    error: AutostartSetCauseItemError::SettingRefused("locked".into()),
                }]))
            } else {
                Ok(AutostartSetResult {
                    enabled: input.enabled,
                })
            })
        }
        Method::SampleOptional => {
            if params.get("value") == Some(&Value::Null) {
                return Err(InvalidParams);
            }
            let input: SampleOptionalParams = parse(params)?;
            encode(if refuse {
                Err(SampleOptionalCause(vec![SampleOptionalCauseItem::Fail {
                    error: SampleOptionalCauseItemError::OptionalRefused { value: input.value },
                }]))
            } else {
                Ok(SampleOptionalResult { value: input.value })
            })
        }
        Method::SampleNullable => {
            let input: SampleNullableParams = parse(params)?;
            encode(if refuse {
                Err(SampleNullableCause(vec![SampleNullableCauseItem::Fail {
                    error: SampleNullableCauseItemError::NullableRefused(input.value),
                }]))
            } else {
                Ok(SampleNullableResult { value: input.value })
            })
        }
    })
}

fn dispatch(
    method: Method,
    params: Value,
    refuse: bool,
    seen: &Dispatches,
) -> Result<Result<Value, Value>, InvalidParams> {
    let result = call(method, &params, refuse);
    let outcome = match result {
        Ok(Ok(_)) => "result",
        Ok(Err(_)) => "refusal",
        Err(_) => "invalid-params",
    };
    seen.lock().unwrap().push(Dispatch {
        method,
        params,
        outcome,
    });
    result
}

pub fn line(input: &str, refuse: bool, marked: bool, seen: &Dispatches) -> String {
    let request: Request = serde_json::from_str(input).unwrap();
    assert_eq!(request.jsonrpc, "2.0");
    let reply = match dispatch(request.method, request.params, refuse, seen) {
        Ok(Ok(result)) => Reply::Result(result),
        Ok(Err(cause)) => Reply::Error(WireError::refusal(cause, marked)),
        Err(_) => Reply::Error(WireError::invalid_params()),
    };
    serde_json::to_string(&Response {
        jsonrpc: "2.0",
        id: request.id,
        reply,
    })
    .unwrap()
}

pub struct Core {
    runtime: tokio::runtime::Runtime,
    methods: RpcModule<Dispatches>,
}

impl Core {
    pub fn new(refuse: bool, seen: Dispatches) -> Self {
        let mut methods = RpcModule::new(seen);
        for (name, method) in [
            ("autostart.show", Method::AutostartShow),
            ("autostart.set", Method::AutostartSet),
            ("sample.optional", Method::SampleOptional),
            ("sample.nullable", Method::SampleNullable),
        ] {
            methods
                .register_method(
                    name,
                    move |params, seen, _| -> Result<Value, ErrorObjectOwned> {
                        let params = params.parse::<Value>()?;
                        match dispatch(method, params, refuse, seen) {
                            Ok(Ok(result)) => Ok(result),
                            Ok(Err(cause)) => {
                                Err(ErrorObjectOwned::owned(0, cause.to_string(), Some(cause)))
                            }
                            Err(_) => Err(ErrorObjectOwned::owned(
                                -32602,
                                "Invalid params",
                                None::<()>,
                            )),
                        }
                    },
                )
                .unwrap();
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        Self { runtime, methods }
    }

    pub fn answer(&self, input: &str) -> String {
        let (reply, _) = self
            .runtime
            .block_on(self.methods.raw_json_request(input, 1))
            .unwrap();
        reply.get().to_owned()
    }
}

pub fn mark_core_refusal(native: &str) -> Option<String> {
    let mut response: Value = serde_json::from_str(native).unwrap();
    let error = response.get_mut("error")?.as_object_mut()?;
    if error.get("code") != Some(&json!(0)) {
        return None;
    }
    error.insert("_tag".into(), json!("Cause"));
    Some(serde_json::to_string(&response).unwrap())
}
