import { stripMarkdown } from '../../src/scrapers/markdown-strip';

describe('stripMarkdown', () => {
  it('strips bold/italic/inline-code emphasis but keeps the words', () => {
    expect(stripMarkdown('This is **bold**, *italic*, and `code`.')).toBe('This is bold, italic, and code.');
  });

  it('keeps link text, drops the URL', () => {
    expect(stripMarkdown('See [the docs](https://example.com/docs) now.')).toBe('See the docs now.');
  });

  it('removes heading and list markers', () => {
    const md = '# Title\n\n- one\n- two\n\n1. first\n2. second';

    expect(stripMarkdown(md)).toBe('Title\n\none\ntwo\n\nfirst\nsecond');
  });

  it('keeps the code inside a fenced block, drops the fences', () => {
    const md = 'Run:\n\n```bash\nnpm test\n```\n';

    expect(stripMarkdown(md)).toContain('npm test');
    expect(stripMarkdown(md)).not.toContain('```');
  });

  it('collapses excess blank lines and trims', () => {
    expect(stripMarkdown('a\n\n\n\nb\n')).toBe('a\n\nb');
  });
});
