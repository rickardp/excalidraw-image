// R-001 — placeholder binary entry point.
//
// Real wiring (argv parsing, file I/O, engine invocation, output writing)
// lands in R-004. This stub exists so `cargo build --release -p
// excalidraw-image` produces a binary to include in the binary-size
// measurement, and so the workspace compiles end-to-end.

fn main() {
    eprintln!(
        "excalidraw-image: not yet wired. Main.rs will be implemented in task R-004."
    );
    std::process::exit(2);
}
