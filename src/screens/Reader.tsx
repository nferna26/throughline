import type { TodayCard, ReaderMode } from "../types";
import TextReader from "./TextReader";
import EpubReader from "./EpubReader";

interface Props {
  today: TodayCard;
  mode?: ReaderMode;
  onExit: () => void;
}

export default function Reader({ today, mode = "full", onExit }: Props) {
  const { book } = today;
  if (book.source_type === "epub") {
    return <EpubReader today={today} mode={mode} onExit={onExit} />;
  }
  // default to text
  return <TextReader today={today} mode={mode} onExit={onExit} />;
}
