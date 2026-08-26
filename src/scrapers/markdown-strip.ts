import { MARKDOWN_STRIP_RULES } from '../common/patterns';

export function stripMarkdown(md: string): string {
  let text = md;

  for (const [pattern, replace] of MARKDOWN_STRIP_RULES) {
    text = text.replace(pattern, replace);
  }

  return text.trim();
}
