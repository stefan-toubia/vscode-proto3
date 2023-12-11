import {
  CancellationToken,
  DocumentSymbol,
  DocumentSymbolProvider,
  Position,
  ProviderResult,
  Range,
  SymbolInformation,
  SymbolKind,
  TextDocument,
} from 'vscode';
import { tokenize, parse } from 'protobufjs';

const matchingBrackets = {
  '[': ']',
  '(': ')',
  '{': '}',
  '<': '>',
};
const closingBrackets = new Set(Object.values(matchingBrackets));
const brackets = new Set([
  ...Object.keys(matchingBrackets),
  ...Object.values(matchingBrackets),
]);

type FieldCardinality = 'required' | 'optional' | 'repeated';

const isFieldCardinality = (s: string): s is FieldCardinality => {
  switch (s) {
    case 'required':
    case 'optional':
    case 'repeated':
      return true;
    default:
      return false;
  }
};

export function parseDocumentSymbol(text: string): DocumentSymbol[] {
  const parsed = parse(text);
  console.log('parsed', parsed);

  const tok = tokenize(text, false);

  const kinds = {
    enum: SymbolKind.Enum,
    message: SymbolKind.Struct,
    oneof: SymbolKind.Enum,
    rpc: SymbolKind.Method,
    service: SymbolKind.Class,
  };

  /**
   * Reads tokens from the tokenizer until the specified end token is reached.
   * This function also handles nested bracket pairs. It keeps track of opening
   * and closing brackets, ensuring they are properly matched and nested.
   * If a mismatch in brackets is detected, an error is thrown.
   * Optionally, a callback function can be executed for each token read.
   */
  function readTo(endToken: string, fn?: (token: string) => void) {
    const stack = [];
    let token: string;
    while ((token = tok.next())) {
      if (closingBrackets.has(token)) {
        const last = stack.pop();
        if (matchingBrackets[last] !== token) {
          throw new Error(
            `Bracket mismatch line ${tok.line} '${last} ${token}'`
          );
        }
      } else if (matchingBrackets[token]) {
        stack.push(token);
      }
      fn?.(token);
      if (token === endToken && stack.length === 0) {
        break;
      }
    }
  }

  const position = () => new Position(tok.line - 1, 0);

  type BlockToken = 'message' | 'enum' | 'service';

  function parseBlock(
    token: BlockToken,
    parent?: DocumentSymbol
  ): DocumentSymbol | undefined {
    const start = position();
    const name = tok.next();
    const symRange = new Range(start, start);
    const symbol = new DocumentSymbol(
      name,
      token,
      kinds[token],
      symRange,
      symRange
    );
    readTo('}', (t) => {
      parseNextDecl(t, { token: token, symbol });
    });
    symbol.range = new Range(start, position());
    parent?.children.push(symbol);
    return symbol;
  }

  function parseMethod(parent?: DocumentSymbol): DocumentSymbol | undefined {
    const start = position();
    const name = tok.next();
    let detail = 'rpc';
    let done = false;
    readTo(';', (token) => {
      if (done) return;
      // rpc declarations may end in a block of option declarations.
      if (token === '{') {
        done = true;
        return;
      }
      if (token === 'returns') {
        detail += ` ${token} `;
      } else if (token !== ';') {
        detail += token;
      }
    });
    const range = new Range(start, position());
    const sym = new DocumentSymbol(name, detail, kinds.rpc, range, range);
    parent?.children.push(sym);
    return sym;
  }

  const fieldKind = (type: string): SymbolKind => {
    switch (type) {
      case 'bool':
        return SymbolKind.Boolean;
      default:
        return SymbolKind.Field;
    }
  };

  function parseField(
    token: string,
    parent: ParentSymbol
  ): DocumentSymbol | undefined {
    const start = position();
    let type = token;
    let detail = type;
    let name = type;
    let card: FieldCardinality;
    let kind: SymbolKind;

    if (type === 'map') {
      detail = 'map';
      readTo('>', (t) => {
        detail += t;
        if (t === ',') {
          detail += ' ';
        }
      });
      name = tok.next();
      kind = SymbolKind.Object;
    } else if (parent.token === 'enum') {
      kind = SymbolKind.EnumMember;
      detail = '';
    } else {
      name = tok.next();
      if (isFieldCardinality(type)) {
        card = type;
        type = name;
        name = tok.next();
        detail = `${card} ${type}`;
      }
      kind = fieldKind(type);
      if (card === 'repeated') {
        kind = SymbolKind.Array;
      }
    }
    const range = new Range(position(), position());
    const sym = new DocumentSymbol(name, detail, kind, range, range);
    if (type === 'oneof') {
      readTo('}', (t) => parseNextDecl(t, { token: t, symbol: sym }));
    } else {
      readTo(';');
    }
    sym.range = new Range(start, position());
    parent.symbol.children.push(sym);
    return sym;
  }

  type ParentSymbol = {
    token: string;
    symbol: DocumentSymbol;
  };

  function parseNextDecl(
    token: string,
    parent?: ParentSymbol
  ): DocumentSymbol | undefined {
    if (brackets.has(token)) {
      return;
    }
    switch (token) {
      case 'message':
      case 'enum':
      case 'service':
        return parseBlock(token, parent?.symbol);
      case 'rpc':
        return parseMethod(parent?.symbol);
      case 'group':
      case 'extend':
        readTo('}'); // Discard
        return;
      case 'option':
      case 'reserved':
        readTo(';'); // Discard
        return;
      default:
        if (parent) {
          return parseField(token, parent);
        }
        readTo(';'); // Discard
    }
  }

  const syms: DocumentSymbol[] = [];
  readTo(null, (token) => {
    const sym = parseNextDecl(token);
    if (sym) {
      syms.push(sym);
    }
  });
  return syms;
}

type ProvideSymbolsResult = ProviderResult<
  SymbolInformation[] | DocumentSymbol[]
>;

export class Proto3DocumentSymbolProvider implements DocumentSymbolProvider {
  cache: Record<
    string,
    {
      version: number;
      result: ProvideSymbolsResult;
    }
  > = {};

  provideDocumentSymbols(
    doc: TextDocument,
    token: CancellationToken
  ): ProvideSymbolsResult {
    const key = doc.uri.toString();
    if (this.cache[key]?.version === doc.version) {
      return this.cache[key].result ?? [];
    }
    let result: ProvideSymbolsResult;
    try {
      result = parseDocumentSymbol(doc.getText());
    } catch (err) {
      if (!doc.isDirty) {
        console.log('Error parsing document symbols:', err);
      }
      // Cache the previous version as the current version and return it.
      result = this.cache[key]?.result ?? [];
    }
    this.cache[key] = {
      version: doc.version,
      result,
    };
    return result;
  }
}
