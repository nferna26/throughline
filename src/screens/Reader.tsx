import type { TodayCard, ReaderMode } from "../types";
import TextReader from "./TextReader";

interface Props {
  today: TodayCard;
  mode?: ReaderMode;
  onExit: () => void;
}

// One reader for every book. EPUBs are converted to clean text at import (see
// import_epub.rs) and read through the same plain-text path as .txt — there is no
// separate epub.js renderer anymore (the iframe made text selection unfixable in
// WKWebView; see docs/EPUB_AI_EVAL.md).
export default function Reader({ today, mode = "full", onExit }: Props) {
  return <TextReader today={today} mode={mode} onExit={onExit} />;
}
