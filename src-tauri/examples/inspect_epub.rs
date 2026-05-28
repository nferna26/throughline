// quick debug: print spine + TOC of an EPUB so we can build a sensible classifier
use std::env;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let path = env::args().nth(1).expect("usage: inspect_epub <path>");
    let p = PathBuf::from(path);
    let doc = epub::doc::EpubDoc::new(&p)?;
    println!("== title    : {}", doc.get_title().unwrap_or_default());
    println!("== version  : {:?}", doc.version);
    println!("== spine ({}):", doc.spine.len());
    for (i, s) in doc.spine.iter().enumerate() {
        let res = doc.resources.get(&s.idref);
        let path = res.map(|r| r.path.to_string_lossy().to_string()).unwrap_or_default();
        let mime = res.map(|r| r.mime.clone()).unwrap_or_default();
        let props = res.map(|r| r.properties.clone()).unwrap_or_default();
        println!(
            "  {:>3} idref={:24} linear={} path={} mime={} props={:?}",
            i, s.idref, s.linear, path, mime, props
        );
    }
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
