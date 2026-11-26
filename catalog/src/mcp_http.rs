//! MCP over Streamable HTTP (`biocartoon mcp --http`), so assistants that only reach remote
//! servers (ChatGPT, claude.ai, Claude's mobile apps) can use the catalog. This is the stateless
//! form of the transport: each POST carries JSON-RPC messages and gets their replies back as one
//! JSON body. There are no sessions and no server-sent events (GET is refused), which every client
//! handles.
//!
//! Requests are spread over a few threads, each with its own tools (and so its own catalog
//! connection). A background thread downloads newer catalogs as they are published, and the tools
//! switch to them.

use crate::mcp::{self, ServerInfo, Tools};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

/// Largest request body taken (an image sent as base64 is the big case).
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// A reply: status, content type and body.
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    /// Methods the path allows, for a 405.
    pub allow: Option<&'static str>,
}

impl Reply {
    fn new(status: u16, content_type: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self { status, content_type, body: body.into(), allow: None }
    }
    fn json(status: u16, v: &Value) -> Self {
        Self::new(status, "application/json", v.to_string())
    }
}

/// The page a person sees opening the server's address in a browser.
const HOME: &str = "BioCartoon MCP server\n\n\
Search about 35,000 open-licensed scientific illustrations and contribute your own from an AI assistant.\n\
Connect your assistant to this address with /mcp at the end (Streamable HTTP, no sign-in).\n\
More: https://github.com/josephrich98/biocartoon#ai-assistants\n";

/// Answer one HTTP request. `local` is true when the server listens only on this machine: then a
/// browser page from anywhere but this machine may not call it (DNS rebinding).
pub fn respond(info: &ServerInfo, tools: &mut dyn Tools, method: &str, path: &str, origin: Option<&str>, body: &[u8], local: bool) -> Reply {
    let path = path.split('?').next().unwrap_or("/");
    if local && origin.is_some_and(|o| !local_origin(o)) {
        return Reply::json(403, &json!({"error": "Origin not allowed"}));
    }
    match (method, path) {
        ("OPTIONS", _) => Reply::new(204, "text/plain", ""),
        ("GET", "/") => Reply::new(200, "text/plain; charset=utf-8", HOME),
        ("GET", "/health") => Reply::new(200, "text/plain", "ok\n"),
        ("POST", "/mcp") | ("POST", "/") => {
            let msg: Value = match serde_json::from_slice(body) {
                Ok(v) => v,
                Err(e) => return Reply::json(400, &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
            };
            let replies: Vec<Value> = match &msg {
                Value::Array(batch) => batch.iter().filter_map(|m| mcp::reply(info, tools, m)).collect(),
                m => mcp::reply(info, tools, m).into_iter().collect(),
            };
            match (msg.is_array(), replies.len()) {
                // Only notifications or responses: nothing to answer.
                (_, 0) => Reply::new(202, "text/plain", ""),
                (false, _) => Reply::json(200, &replies[0]),
                (true, _) => Reply::json(200, &Value::Array(replies)),
            }
        }
        (_, "/mcp") => Reply { allow: Some("POST, OPTIONS"), ..Reply::json(405, &json!({"error": "This server answers POST only (no event stream)"})) },
        _ => Reply::json(404, &json!({"error": "Not found"})),
    }
}

fn local_origin(origin: &str) -> bool {
    let rest = origin.split("://").nth(1).unwrap_or(origin);
    let host = if rest.starts_with("[::1]") { "[::1]" } else { rest.split(['/', ':']).next().unwrap_or_default() };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// Where to listen by default: `0.0.0.0:$PORT` when `PORT` is set (as container hosts do),
/// else `127.0.0.1:8080`.
pub fn default_addr() -> String {
    match std::env::var("PORT") {
        Ok(p) if !p.trim().is_empty() => format!("0.0.0.0:{}", p.trim()),
        _ => "127.0.0.1:8080".into(),
    }
}

/// Serve MCP over HTTP on `addr` with `threads` workers, each running the tools `make` builds.
/// With `sync_every`, a background thread downloads a newer catalog that often.
pub fn serve<F>(info: ServerInfo, addr: &str, threads: usize, sync_every: Option<Duration>, make: F) -> Result<(), String>
where
    F: Fn() -> Box<dyn Tools + Send> + Send + Sync + 'static,
{
    let server = Arc::new(tiny_http::Server::http(addr).map_err(|e| format!("listen on {addr}: {e}"))?);
    let local = addr.starts_with("127.") || addr.starts_with("localhost") || addr.starts_with("[::1]");
    eprintln!("BioCartoon MCP server on http://{addr}/mcp");
    if let Some(every) = sync_every {
        std::thread::spawn(move || loop {
            if let Err(e) = crate::query::ensure_catalog(true, |_| {}) {
                eprintln!("catalog sync failed: {e}");
            }
            std::thread::sleep(every);
        });
    }
    let info = Arc::new(info);
    let make = Arc::new(make);
    let workers: Vec<_> = (0..threads.max(1))
        .map(|_| {
            let (server, info, make) = (server.clone(), info.clone(), make.clone());
            std::thread::spawn(move || {
                let mut tools = make();
                while let Ok(rq) = server.recv() {
                    handle(&info, tools.as_mut(), rq, local);
                }
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
    Ok(())
}

fn handle(info: &ServerInfo, tools: &mut dyn Tools, mut rq: tiny_http::Request, local: bool) {
    let method = rq.method().as_str().to_string();
    let path = rq.url().to_string();
    let origin = rq.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("origin")).map(|h| h.value.as_str().to_string());
    let mut body = Vec::new();
    let too_big = rq.body_length().is_some_and(|n| n > MAX_BODY_BYTES) || {
        let r = rq.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut body);
        r.is_err() || body.len() > MAX_BODY_BYTES
    };
    let started = std::time::Instant::now();
    let reply = if too_big {
        Reply::json(413, &json!({"error": format!("request larger than {} MB", MAX_BODY_BYTES / (1024 * 1024))}))
    } else {
        respond(info, tools, &method, &path, origin.as_deref(), &body, local)
    };
    let what = serde_json::from_slice::<Value>(&body).ok().map(|m| summarize(&m)).unwrap_or_default();
    eprintln!("{method} {path} {} {}ms {what}", reply.status, started.elapsed().as_millis());
    let h = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    let mut res = tiny_http::Response::from_data(reply.body)
        .with_status_code(reply.status)
        .with_header(h("Content-Type", reply.content_type))
        .with_header(h("Access-Control-Allow-Origin", "*"))
        .with_header(h("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(h("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID"))
        .with_header(h("Access-Control-Max-Age", "86400"));
    if let Some(allow) = reply.allow {
        res = res.with_header(h("Allow", allow));
    }
    let _ = rq.respond(res);
}

/// The method (and tool) of a request, for the log; never its arguments.
fn summarize(m: &Value) -> String {
    let one = |m: &Value| {
        let method = m["method"].as_str().unwrap_or("-");
        match m["params"]["name"].as_str() {
            Some(t) if method == "tools/call" => format!("{method}:{t}"),
            _ => method.to_string(),
        }
    };
    match m {
        Value::Array(a) => a.iter().map(one).collect::<Vec<_>>().join(","),
        m => one(m),
    }
}

/// `biocartoon mcp --http`: the catalog and submission tools over HTTP. Local files can't be
/// submitted: whoever calls a hosted server isn't on its machine.
pub fn serve_catalog(addr: &str, threads: usize) -> Result<(), String> {
    serve(mcp::catalog_server_info(), addr, threads, Some(Duration::from_secs(30 * 60)), || {
        Box::new(mcp::Chain(vec![
            Box::new(mcp::CatalogTools::reloading(Duration::from_secs(5 * 60))),
            Box::new(crate::mcp_submit::SubmitTools { local_files: false }),
            Box::new(crate::mcp_figure::FigureTools { local_files: false }),
        ]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo;
    impl Tools for Echo {
        fn tools(&self) -> Vec<Value> {
            vec![mcp::tool("echo", "Echo", "Echo.", json!({}), &[])]
        }
        fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
            (name == "echo").then(|| Ok(vec![mcp::text(args.to_string())]))
        }
    }

    fn info() -> ServerInfo {
        ServerInfo { name: "t", version: "0", instructions: "hi".into() }
    }

    fn post(body: &str) -> Reply {
        respond(&info(), &mut Echo, "POST", "/mcp", None, body.as_bytes(), false)
    }

    fn body(r: &Reply) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn requests_notifications_and_batches() {
        let r = post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#);
        assert_eq!((r.status, r.content_type), (200, "application/json"));
        assert_eq!(body(&r)["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).status, 202);
        let r = post(r#"[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"a":1}}}]"#);
        let v = body(&r);
        assert_eq!(v.as_array().unwrap().len(), 2);
        assert_eq!(v[0]["result"]["tools"][0]["name"], "echo");
        assert_eq!(v[1]["result"]["content"][0]["text"], r#"{"a":1}"#);
        assert_eq!(post("{nope").status, 400);
    }

    #[test]
    fn routes_and_origins() {
        let mut t = Echo;
        let i = info();
        assert_eq!(respond(&i, &mut t, "GET", "/mcp", None, b"", false).status, 405);
        assert_eq!(respond(&i, &mut t, "GET", "/health", None, b"", false).status, 200);
        assert_eq!(respond(&i, &mut t, "GET", "/nope", None, b"", false).status, 404);
        assert_eq!(respond(&i, &mut t, "OPTIONS", "/mcp", Some("https://chatgpt.com"), b"", false).status, 204);
        let ping = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(respond(&i, &mut t, "POST", "/mcp", Some("https://evil.example"), ping, true).status, 403);
        assert_eq!(respond(&i, &mut t, "POST", "/mcp", Some("http://localhost:6274"), ping, true).status, 200);
        assert_eq!(respond(&i, &mut t, "POST", "/mcp?x=1", Some("https://claude.ai"), ping, false).status, 200);
    }
}
