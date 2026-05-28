import type { TodayCard } from "../types";
import TextReader from "./TextReader";
import EpubReader from "./EpubReader";

interface Props {
  today: TodayCard;
  onExit: () => void;
}

export default function Reader({ today, onExit }: Props) {
  const { book } = today;
  if (book.source_type === "epub") {
    return <EpubReader today={today} onExit={onExit} />;
  }
  // default to text
  return <TextReader today={today} onExit={onExit} />;
}
