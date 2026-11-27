use schemars::schema::Schema;
use serde_json::{Value, json};
use std::{collections::BTreeMap, error::Error};
use typify::{TypeSpace, TypeSpaceSettings};

fn method_name(method: &str) -> String {
    method
        .split('.')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().unwrap().to_ascii_uppercase().to_string() + chars.as_str()
        })
        .collect()
}

fn main() -> Result<(), Box<dyn Error>> {
    let openrpc: Value = serde_json::from_str(include_str!("../../schema/extended.openrpc.json"))?;
    let causes: Value = serde_json::from_str(include_str!("../../schema/extended.causes.json"))?;
    let mut definitions: BTreeMap<String, Schema> =
        serde_json::from_value(causes["definitions"].clone())?;
    assert!(
        openrpc["components"]["schemas"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    for method in openrpc["methods"].as_array().unwrap() {
        let name = method_name(method["name"].as_str().unwrap());
        let no_params = json!({ "type": "null" });
        let params = match method.get("x-effect-params-schema") {
            Some(schema) => schema,
            None => {
                assert_eq!(method["params"], json!([]));
                &no_params
            }
        };
        for (suffix, schema) in [("Params", params), ("Result", &method["result"]["schema"])] {
            let root = serde_json::from_value(schema.clone())?;
            assert!(
                definitions
                    .insert(format!("{name}{suffix}"), root)
                    .is_none()
            );
        }
    }
    let mut types = TypeSpace::new(&TypeSpaceSettings::default());
    types.add_ref_types(definitions)?;
    let file = syn::parse2(types.to_stream()?)?;
    print!("{}", prettyplease::unparse(&file));
    Ok(())
}
