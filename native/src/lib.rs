//! Node.js bindings for cev: the engine and the decision runtime behind one
//! class whose methods take and return the REST bodies as JSON text. The
//! TypeScript wrapper in `../src` adds the types.
//!
//! The JavaScript thread only queues work. Forward passes run on their own
//! worker threads (`concurrency` of them), feedback and log reads on another,
//! and each job settles a promise when it is done. The tensor kernels fan out
//! over rayon's pool (`threads`), which is shared by the whole process.

use cev_core::{Backend, Debias, ExamplesRequest, FeedbackRequest, MockBackend, SystemOneRequest};
use cev_model::{Engine, EngineOptions};
use cev_runtime::{Cev as Runtime, CevError, CevResult, ExportFilter, LearnConfig, RuntimeConfig, Store};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

/// `Cev.load` / `Cev.mock` options, as sent by the wrapper.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    mock: bool,
    model: Option<String>,
    name: Option<String>,
    device: Option<String>,
    dtype: Option<String>,
    max_context: Option<usize>,
    prefix_cache_tokens: Option<usize>,
    db: Option<String>,
    online_learning: Option<bool>,
    store_features: Option<bool>,
    min_examples: Option<u64>,
    debias: Option<Debias>,
    max_permutations: Option<usize>,
    threads: Option<usize>,
    concurrency: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Page {
    task: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

/// Size of rayon's global pool once this module has set it.
static THREADS: OnceLock<usize> = OnceLock::new();

/// Performance cores on Apple Silicon. The efficiency cores slow the matmul
/// kernels down: work is split evenly, so every pass waits for the slow ones.
#[cfg(target_os = "macos")]
fn performance_cores() -> Option<usize> {
    let mut n: i32 = 0;
    let mut len = std::mem::size_of::<i32>();
    let rc = unsafe { libc::sysctlbyname(c"hw.perflevel0.physicalcpu".as_ptr(), (&raw mut n).cast(), &mut len, std::ptr::null_mut(), 0) };
    (rc == 0 && n > 0).then_some(n as usize)
}

#[cfg(not(target_os = "macos"))]
fn performance_cores() -> Option<usize> {
    None
}

fn cores() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from)
}

/// Size rayon's global pool: the `threads` option, else `RAYON_NUM_THREADS`,
/// else the performance cores. The pool is process-wide and built once, so
/// only the first instance's `threads` counts.
fn init_threads(requested: Option<usize>) -> usize {
    *THREADS.get_or_init(|| {
        let env = std::env::var("RAYON_NUM_THREADS").ok().and_then(|s| s.parse().ok());
        let n = requested.or(env).filter(|n| *n > 0).unwrap_or_else(|| performance_cores().unwrap_or_else(cores));
        // Fails when something else in the process built the pool first; the
        // size it has is then the answer.
        let _ = rayon::ThreadPoolBuilder::new().num_threads(n).thread_name(|i| format!("cev-cpu-{i}")).build_global();
        rayon::current_num_threads()
    })
}

/// `CEV_LOG=debug` prints the engine's log (per-pass timings) to stderr.
fn init_log() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        if let Ok(filter) = std::env::var("CEV_LOG") {
            let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
        }
    });
}

type Job = Box<dyn FnOnce(&Runtime) + Send>;

/// FIFO of jobs for a fixed set of worker threads.
#[derive(Default)]
struct Queue {
    jobs: Mutex<(VecDeque<Job>, bool)>,
    ready: Condvar,
}

impl Queue {
    fn push(&self, job: Job) {
        self.jobs.lock().expect("queue lock").0.push_back(job);
        self.ready.notify_one();
    }

    /// The next job; `None` once the queue is closed and drained.
    fn pop(&self) -> Option<Job> {
        let mut state = self.jobs.lock().expect("queue lock");
        loop {
            if let Some(job) = state.0.pop_front() {
                return Some(job);
            }
            if state.1 {
                return None;
            }
            state = self.ready.wait(state).expect("queue lock");
        }
    }

    fn close(&self) {
        self.jobs.lock().expect("queue lock").1 = true;
        self.ready.notify_all();
    }
}

struct Shared {
    runtime: Runtime,
    /// Forward passes.
    passes: Queue,
    /// Feedback and log reads, so they never wait behind a pass.
    log: Queue,
    concurrency: usize,
    threads: usize,
}

impl Shared {
    fn open(o: Options) -> anyhow::Result<Arc<Self>> {
        init_log();
        let threads = init_threads(o.threads);
        let backend: Arc<dyn Backend> = if o.mock {
            Arc::new(MockBackend::default())
        } else {
            let d = EngineOptions::default();
            Arc::new(Engine::load(EngineOptions {
                model: o.model.unwrap_or(d.model),
                device: o.device.unwrap_or(d.device),
                dtype: o.dtype.unwrap_or(d.dtype),
                max_context: o.max_context.unwrap_or(d.max_context),
                prefix_cache_tokens: o.prefix_cache_tokens.unwrap_or(d.prefix_cache_tokens),
                name: o.name,
                ..d
            })?)
        };
        let d = RuntimeConfig::default();
        let cfg = RuntimeConfig {
            online_learning: o.online_learning.unwrap_or(d.online_learning),
            store_features: o.store_features.unwrap_or(d.store_features),
            learn: LearnConfig { min_examples: o.min_examples.unwrap_or(d.learn.min_examples), ..d.learn },
            debias: o.debias.unwrap_or(d.debias),
            max_permutations: o.max_permutations.unwrap_or(d.max_permutations),
        };
        let store = match o.db.as_deref() {
            None | Some(":memory:") => Store::in_memory()?,
            Some(path) => Store::open(path)?,
        };
        let concurrency = o.concurrency.unwrap_or(1).max(1);
        let shared = Arc::new(Self { runtime: Runtime::new(backend, store, cfg)?, passes: Queue::default(), log: Queue::default(), concurrency, threads });
        for i in 0..concurrency {
            worker(&shared, format!("cev-pass-{i}"), |s| &s.passes)?;
        }
        worker(&shared, "cev-log".into(), |s| &s.log)?;
        Ok(shared)
    }

    /// Stop the workers once they have drained their queues. They hold the
    /// last references, so the weights are freed when they exit.
    fn close(&self) {
        self.passes.close();
        self.log.close();
    }
}

fn worker(shared: &Arc<Shared>, name: String, queue: fn(&Shared) -> &Queue) -> std::io::Result<()> {
    let shared = shared.clone();
    std::thread::Builder::new().name(name).spawn(move || {
        while let Some(job) = queue(&shared).pop() {
            job(&shared.runtime);
        }
    })?;
    Ok(())
}

/// Errors cross to JavaScript as `<code>: <message>`; the wrapper turns the
/// code into `CevError.code`.
fn fail(code: &str, message: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("{code}: {message}"))
}

fn error(e: CevError) -> Error {
    let code = match &e {
        CevError::BadRequest(_) => "bad_request",
        CevError::NotFound(_) => "not_found",
        CevError::Internal(_) => "internal",
    };
    fail(code, format_args!("{e:#}"))
}

fn panicked(p: Box<dyn std::any::Any + Send>) -> Error {
    let what = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned());
    fail("internal", format_args!("panic: {}", what.unwrap_or_else(|| "unknown".into())))
}

fn parse<T: DeserializeOwned>(text: &str) -> CevResult<T> {
    serde_json::from_str(text).map_err(|e| CevError::BadRequest(e.to_string()))
}

fn text(v: &impl serde::Serialize) -> CevResult<String> {
    serde_json::to_string(v).map_err(|e| CevError::Internal(e.into()))
}

/// Run a forward pass on a thread of the CPU pool. candle's CPU kernels fork
/// into that pool many times per layer: from inside it a fork is a
/// work-stealing join, from outside a handoff to another thread and a sleep.
fn in_pool<T: Send>(pass: impl FnOnce() -> T + Send) -> T {
    let mut out = None;
    rayon::scope(|_| out = Some(pass()));
    out.expect("scope ran the pass")
}

type Reply<T> = Box<dyn FnOnce(Env) -> Result<T>>;

/// Library version, the tensor backends compiled in, and the CPU pool.
#[napi]
pub fn info() -> String {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "metal": cfg!(any(feature = "metal", target_os = "macos")),
        "accelerate": cfg!(any(feature = "accelerate", target_os = "macos")),
        "cuda": cfg!(feature = "cuda"),
        "cores": cores(),
        "performanceCores": performance_cores(),
        "threads": THREADS.get(),
    })
    .to_string()
}

/// Load a model (or the mock) and start its workers. Resolves to a `Cev`.
#[napi]
pub fn open<'env>(env: &'env Env, options: String) -> Result<Object<'env>> {
    let options: Options = serde_json::from_str(&options).map_err(|e| fail("bad_request", e))?;
    let (deferred, promise) = env.create_deferred::<Cev, Reply<Cev>>()?;
    std::thread::Builder::new().name("cev-load".into()).spawn(move || match catch_unwind(|| Shared::open(options)) {
        Ok(Ok(shared)) => deferred.resolve(Box::new(move |_| Ok(Cev { shared: Some(shared) }))),
        Ok(Err(e)) => deferred.reject(fail("internal", format_args!("{e:#}"))),
        Err(p) => deferred.reject(panicked(p)),
    })?;
    Ok(promise)
}

#[napi]
pub struct Cev {
    /// `None` once closed.
    shared: Option<Arc<Shared>>,
}

impl Cev {
    fn shared(&self) -> Result<&Arc<Shared>> {
        self.shared.as_ref().ok_or_else(|| fail("closed", "this Cev instance is closed"))
    }

    /// Queue `work` and return the promise it settles.
    fn submit<'env>(
        &self,
        env: &'env Env,
        queue: fn(&Shared) -> &Queue,
        work: impl FnOnce(&Runtime) -> CevResult<String> + Send + 'static,
    ) -> Result<Object<'env>> {
        let shared = self.shared()?;
        let (deferred, promise) = env.create_deferred::<String, Reply<String>>()?;
        queue(shared).push(Box::new(move |runtime| match catch_unwind(AssertUnwindSafe(|| work(runtime))) {
            Ok(Ok(out)) => deferred.resolve(Box::new(move |_| Ok(out))),
            Ok(Err(e)) => deferred.reject(error(e)),
            Err(p) => deferred.reject(panicked(p)),
        }));
        Ok(promise)
    }
}

#[napi]
impl Cev {
    /// `GET /v1/models`, plus how this instance runs.
    #[napi]
    pub fn model(&self) -> Result<String> {
        let shared = self.shared()?;
        let mut info = serde_json::to_value(shared.runtime.model_info()).map_err(|e| fail("internal", e))?;
        info["threads"] = json!(shared.threads);
        info["concurrency"] = json!(shared.concurrency);
        Ok(info.to_string())
    }

    /// `POST /v1/systemone`
    #[napi]
    pub fn decide<'env>(&self, env: &'env Env, request: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.passes, move |cev| {
            let request = parse::<SystemOneRequest>(&request)?;
            text(&in_pool(|| cev.decide(&request))?)
        })
    }

    /// `POST /v1/examples`
    #[napi]
    pub fn examples<'env>(&self, env: &'env Env, request: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.passes, move |cev| {
            let request = parse::<ExamplesRequest>(&request)?;
            let out = in_pool(|| cev.examples(&request))?;
            text(&out.into_iter().map(|(response, feedback)| json!({"response": response, "feedback": feedback})).collect::<Vec<_>>())
        })
    }

    /// `POST /v1/feedback`
    #[napi]
    pub fn feedback<'env>(&self, env: &'env Env, request: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, move |cev| text(&cev.feedback(&parse::<FeedbackRequest>(&request)?)?))
    }

    /// `GET /v1/tasks`
    #[napi]
    pub fn tasks<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, |cev| text(&cev.tasks()))
    }

    /// `DELETE /v1/tasks/{task}`
    #[napi]
    pub fn reset_task<'env>(&self, env: &'env Env, task: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, move |cev| text(&cev.reset_task(&task)?))
    }

    /// `GET /v1/decisions`
    #[napi]
    pub fn decisions<'env>(&self, env: &'env Env, page: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, move |cev| {
            let p: Page = parse(&page)?;
            text(&cev.store().recent_decisions(p.task.as_deref(), p.limit.unwrap_or(50).min(1000), p.offset.unwrap_or(0))?)
        })
    }

    /// `GET /v1/decisions/{id}`; `null` when there is no such decision.
    #[napi]
    pub fn decision<'env>(&self, env: &'env Env, id: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, move |cev| {
            let Some((decision, feedback)) = cev.decision(&id)? else { return Ok("null".into()) };
            let request = cev.store().request(&decision.request_id)?;
            let prompt = request.as_ref().map(|r| format!("{}{}", r.prefix, decision.suffix));
            text(&json!({"decision": decision, "state": request.map(|r| r.state), "prompt": prompt, "feedback": feedback}))
        })
    }

    /// `GET /v1/export`: NDJSON training rows.
    #[napi]
    pub fn export<'env>(&self, env: &'env Env, filter: String) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, move |cev| {
            let mut out = String::new();
            cev.export(&parse::<ExportFilter>(&filter)?, |row| {
                out.push_str(&serde_json::to_string(&row)?);
                out.push('\n');
                Ok(())
            })?;
            Ok(out)
        })
    }

    /// `GET /v1/stats`
    #[napi]
    pub fn stats<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        self.submit(env, |s| &s.log, |cev| text(&json!({"store": cev.stats()?, "tasks": cev.tasks().len(), "model": cev.model_info()})))
    }

    /// Stop the workers after the calls already queued and free the model.
    #[napi]
    pub fn close(&mut self) {
        if let Some(shared) = self.shared.take() {
            shared.close();
        }
    }
}

impl Drop for Cev {
    fn drop(&mut self) {
        self.close();
    }
}
