use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

mod session_inspection;

const HELP: &str = "vesicle-rust-dev — Rust development entry\n\nUsage: vesicle-rust-dev [--help | --version]\n       vesicle-rust-dev inspect-session FILE [--head UUID]\n\nSession inspection is read-only; attachments are not verified.\nThis prototype has no interactive or provider runtime yet.\nUse the existing vesicle command for supported workflows.\n";
const VERSION: &str = concat!("vesicle-rust-dev ", env!("CARGO_PKG_VERSION"), "\n");

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let output = match args.as_slice() {
        [] => Ok(HELP.to_owned()),
        [arg] if arg == "--help" || arg == "-h" => Ok(HELP.to_owned()),
        [arg] if arg == "--version" || arg == "-V" => Ok(VERSION.to_owned()),
        [command, path] if command == "inspect-session" => session_inspection::read(path, None),
        [command, path, flag, head]
            if command == "inspect-session"
                && flag == "--head"
                && head.to_str().is_some_and(|head| !head.is_empty()) =>
        {
            session_inspection::read(path, head.to_str())
        }
        _ => {
            let _ = writeln!(
                io::stderr(),
                "Unsupported arguments. Use --help for available commands."
            );
            return ExitCode::from(2);
        }
    };
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let _ = writeln!(
                io::stderr(),
                "{}",
                serde_json::json!({"error": error.code, "line": error.line})
            );
            return ExitCode::FAILURE;
        }
    };
    match io::stdout().lock().write_all(output.as_bytes()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
