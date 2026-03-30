fn main() {
    let target = std::env::var("TARGET").expect("Cargo should provide TARGET to build scripts");
    println!("cargo:rustc-env=SCHEMA_STUDIO_BUILD_TARGET={target}");
    tauri_build::build()
}
