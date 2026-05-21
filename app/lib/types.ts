export type Feed = {
  id: string;
  url: string;
  title: string;
  category?: string;
  addedAt: number;
};

export type Article = {
  id: string;
  feedId: string;
  feedTitle: string;
  title: string;
  link: string;
  author?: string;
  publishedAt?: number;
  contentHtml?: string;
  contentText?: string;
  hasFullContent?: boolean;
  summary?: string;
};

export type AIStyle = "openai" | "anthropic";

export type AIConfig = {
  endpoint: string;
  model: string;
  style: AIStyle;
};

export type ParsedFeed = {
  title: string;
  items: ParsedItem[];
};

export type ParsedItem = {
  title: string;
  link: string;
  author?: string;
  publishedAt?: number;
  contentHtml?: string;
  contentText?: string;
  hasFullContent?: boolean;
  guid?: string;
};
