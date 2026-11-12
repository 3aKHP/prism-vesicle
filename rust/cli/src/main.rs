use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

const HELP: &str = "vesicle-rust-dev — Rust development entry\n\nUsage: vesicle-rust-dev [--help | --version]\n\nThis prototype has no interactive or provider runtime yet.\nUse the existing vesicle command for supported workflows.\n";
const VERSION: &str = concat!("vesicle-rust-dev ", env!("CARGO_PKG_VERSION"), "\n");

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let first = args.next();
    let output = match (first.as_deref(), args.next()) {
        (None, None) => HELP,
        (Some(arg), None) if arg == "--help" || arg == "-h" => HELP,
        (Some(arg), None) if arg == "--version" || arg == "-V" => VERSION,
        _ => {
            let _ = writeln!(
                io::stderr(),
                "Unsupported arguments. Use --help for available commands."
            );
            return ExitCode::from(2);
        }
    };
    match io::stdout().lock().write_all(output.as_bytes()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
