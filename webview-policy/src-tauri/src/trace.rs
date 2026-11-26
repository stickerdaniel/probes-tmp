use serde_json::{json, Map, Value};
use std::{
    fs::File,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tracing::{
    field::{Field, Visit},
    span::{Attributes, Id, Record},
    Event, Level, Subscriber,
};
use tracing_subscriber::{layer::Context, prelude::*, registry::LookupSpan, Layer};

struct Fields(Map<String, Value>);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), json!(value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().into(), json!(format!("{value:?}")));
    }
}

struct IpcLayer(Mutex<File>, AtomicU64);

struct Seq(u64);

impl IpcLayer {
    fn write(&self, line: Value) {
        let mut f = self.0.lock().unwrap();
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for IpcLayer {
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let name = attrs.metadata().name();
        if !name.starts_with("ipc::") {
            return;
        }
        let mut fields = Fields(Map::new());
        attrs.record(&mut fields);
        let Some(span) = ctx.span(id) else { return };
        let parent = span.parent().and_then(|p| p.extensions().get::<Seq>().map(|s| s.0));
        let seq = self.1.fetch_add(1, Ordering::Relaxed);
        span.extensions_mut().insert(Seq(seq));
        self.write(json!({ "t": "span", "id": seq, "parent": parent, "name": name, "fields": fields.0 }));
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        let Some(seq) = span.extensions().get::<Seq>().map(|s| s.0) else { return };
        let mut fields = Fields(Map::new());
        values.record(&mut fields);
        self.write(json!({ "t": "record", "id": seq, "fields": fields.0 }));
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let meta = event.metadata();
        let ipc_span = ctx.event_span(event).filter(|s| s.name().starts_with("ipc::"));
        if *meta.level() > Level::WARN && ipc_span.is_none() {
            return;
        }
        let mut fields = Fields(Map::new());
        event.record(&mut fields);
        self.write(json!({
            "t": "event",
            "span": ipc_span.and_then(|s| s.extensions().get::<Seq>().map(|s| s.0)),
            "level": meta.level().as_str(),
            "target": meta.target(),
            "fields": fields.0,
        }));
    }
}

pub fn install(path: PathBuf) {
    let layer = IpcLayer(Mutex::new(File::create(path).expect("trace file")), AtomicU64::new(1));
    let filter = tracing_subscriber::filter::filter_fn(|m| m.target().starts_with("tauri") || m.target().starts_with("wry"));
    tracing_subscriber::registry().with(layer.with_filter(filter)).init();
}
