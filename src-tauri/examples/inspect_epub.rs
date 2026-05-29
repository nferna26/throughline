// quick debug: print spine + TOC of an EPUB so we can build a sensible classifier
use std::env;
use std::path::PathBuf;

// Mirror of import_epub::html_text_len (private there) for verification output.
fn html_len(html: &str) -> usize {
    let mut count = 0usize;
    let mut in_tag = false;
    let mut prev_ws = true;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if in_tag => {}
            c if c.is_whitespace() => {
                if !prev_ws {
                    count += 1;
                    prev_ws = true;
                }
            }
            _ => {
                count += 1;
                prev_ws = false;
            }
        }
    }
    count
}

fn main() -> anyhow::Result<()> {
    let path = env::args().nth(1).expect("usage: inspect_epub <path>");
    let p = PathBuf::from(path);
    let mut doc = epub::doc::EpubDoc::new(&p)?;
    println!("== title    : {}", doc.get_title().unwrap_or_default());
    println!("== version  : {:?}", doc.version);
    println!("== spine ({}):", doc.spine.len());
    let idrefs: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
    let linears: Vec<bool> = doc.spine.iter().map(|s| s.linear).collect();
    let metas: Vec<(String, String)> = idrefs
        .iter()
        .map(|id| {
            let res = doc.resources.get(id);
            (
                res.map(|r| r.path.to_string_lossy().to_string()).unwrap_or_default(),
                res.map(|r| r.mime.clone()).unwrap_or_default(),
            )
        })
        .collect();
    let mut total = 0usize;
    for (i, id) in idrefs.iter().enumerate() {
        let (path, mime) = &metas[i];
        // Same length heuristic the importer uses, surfaced for verification.
        let chars = doc.get_resource_str(id).map(|(h, _)| html_len(&h)).unwrap_or(0);
        total += chars;
        println!(
            "  {:>3} idref={:24} linear={} chars~{:>6} path={} mime={}",
            i, id, linears[i], chars, path, mime
        );
    }
    println!("== total readable chars ~ {} (≈ {} min @200wpm)", total, ((total as f64 / 5.0) / 200.0).ceil() as i64);
    println!("== toc ({}):", doc.toc.len());
    fn walk(n: &epub::doc::NavPoint, d: usize) {
        let pad = " ".repeat(d * 2);
        println!("  {}- {:<40} → {}", pad, n.label, n.content.to_string_lossy());
        for c in &n.children {
            walk(c, d + 1);
        }
    }
    for n in &doc.toc {
        walk(n, 0);
    }
    Ok(())
}
