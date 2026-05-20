export type Feed = {
  id: string;
  url: string;
  title: string;
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
  summary?: string;
};

export type AIConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
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
  guid?: string;
};
