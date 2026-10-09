fn main() {
    watch_icons_dir("icons");
    tauri_build::build()
}

fn watch_icons_dir(dir: &str) {
    let path = std::path::Path::new(dir);
    if !path.is_dir() {
        return;
    }
    println!("cargo:rerun-if-changed={}", path.display());
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                println!("cargo:rerun-if-changed={}", p.display());
            }
        }
    }
}
