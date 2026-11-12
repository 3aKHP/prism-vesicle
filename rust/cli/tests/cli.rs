use std::process::Command;

// Exercise the compiled native executable: accidentally accepting an unsupported
// workflow must not look like a working Rust replacement for the TS runtime.
#[test]
fn unsupported_workflows_fail_without_success_output() {
    for args in [
        vec!["resume"],
        vec!["--help", "unexpected"],
        vec!["--version", "unexpected"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_vesicle-rust-dev"))
            .args(args)
            .output()
            .expect("start native development binary");
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn help_discloses_prototype_scope() {
    for args in [vec![], vec!["--help"], vec!["-h"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_vesicle-rust-dev"))
            .args(args)
            .output()
            .expect("start native development binary");
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("no interactive or provider runtime"));
        assert!(stdout.contains("--version"));
    }
}

#[test]
fn version_identifies_the_development_binary() {
    let output = Command::new(env!("CARGO_BIN_EXE_vesicle-rust-dev"))
        .arg("--version")
        .output()
        .expect("start native development binary");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "vesicle-rust-dev 2.0.0-dev.1\n"
    );
}
