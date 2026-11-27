#[allow(dead_code)]
mod generated;
mod handler;

use handler::{Core, Dispatch, Dispatches, Request, line, mark_core_refusal};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Backend {
    SerdeJson,
    CoreNative,
    CoreRewrite,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trial {
    backend: Backend,
    name: String,
    requests: usize,
    #[serde(default)]
    refuse: bool,
    #[serde(default)]
    plain: bool,
    #[serde(default)]
    loss: bool,
    #[serde(default)]
    reverse: bool,
    #[serde(default)]
    drop_last: bool,
    replace_params: Option<Value>,
    replace_first_reply: Option<Value>,
}

#[derive(Serialize)]
struct Observation {
    requests: Vec<String>,
    dispatched: Vec<Dispatch>,
    native_replies: Vec<String>,
    sent: Vec<String>,
    rewrites: usize,
    caller: Value,
}

fn exchange(trial: &Trial, child: &mut Child) -> Result<Observation, Box<dyn std::error::Error>> {
    let seen = Dispatches::default();
    let core = match trial.backend {
        Backend::SerdeJson => None,
        _ => Some(Core::new(trial.refuse, seen.clone())),
    };
    let mut sink = child.stdin.take();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let (signal, source) = mpsc::channel();
    let read = std::thread::spawn(move || {
        for line in reader.lines() {
            if signal.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut observation = Observation {
        requests: vec![],
        dispatched: vec![],
        native_replies: vec![],
        sent: vec![],
        rewrites: 0,
        caller: Value::Null,
    };
    let mut outbox = vec![];
    loop {
        let incoming = match source.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(line) => line?,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(error) => return Err(error.into()),
        };
        let mut request: Request = serde_json::from_str(&incoming)?;
        observation.requests.push(incoming.clone());
        assert!(
            observation.requests.len() <= trial.requests,
            "unexpected request"
        );
        let effective =
            if let Some(params) = trial.replace_params.as_ref().filter(|_| outbox.is_empty()) {
                request.params = params.clone();
                serde_json::to_string(&request)?
            } else {
                incoming
            };

        let mut answer = if let Some(core) = &core {
            let native = core.answer(&effective);
            let rewritten = matches!(trial.backend, Backend::CoreRewrite) && !trial.plain;
            let marked = rewritten.then(|| mark_core_refusal(&native)).flatten();
            observation.native_replies.push(native.clone());
            observation.rewrites += usize::from(marked.is_some());
            marked.unwrap_or(native)
        } else {
            line(&effective, trial.refuse, !trial.plain, &seen)
        };

        if let Some(replacement) = trial
            .replace_first_reply
            .as_ref()
            .filter(|_| outbox.is_empty())
        {
            let mut replacement = replacement.clone();
            replacement["jsonrpc"] = "2.0".into();
            replacement["id"] = request.id.into();
            answer = serde_json::to_string(&replacement)?;
        }
        answer.push('\n');
        outbox.push(answer);
        if outbox.len() != trial.requests {
            continue;
        }

        if trial.loss {
            drop(sink.take());
            continue;
        }
        if trial.drop_last {
            assert!(outbox.pop().is_some());
        }
        if trial.reverse {
            outbox.reverse();
        }
        let writer = sink.as_mut().unwrap();
        for reply in &outbox {
            writer.write_all(reply.as_bytes())?;
            writer.flush()?;
            observation.sent.push(reply.clone());
        }
    }
    read.join().unwrap();
    assert_eq!(
        observation.requests.len(),
        trial.requests,
        "missing request"
    );
    assert!(child.wait()?.success(), "caller exited with an error");
    observation.caller = serde_json::from_reader(child.stderr.take().unwrap())?;
    observation.dispatched = seen.lock().unwrap().clone();
    Ok(observation)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let trial: Trial = serde_json::from_reader(std::io::stdin().lock())?;
    let bun = std::env::args_os()
        .nth(1)
        .ok_or("expected the Bun executable")?;
    let mut child = Command::new(bun)
        .args(["caller.ts", &trial.name])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        exchange(&trial, &mut child)
    }));
    if child.try_wait()?.is_none() {
        child.kill()?;
        child.wait()?;
    }
    match result {
        Ok(observation) => {
            println!("{}", serde_json::to_string(&observation?)?);
            Ok(())
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
