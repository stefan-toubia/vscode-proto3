import * as chai from 'chai';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseDocumentSymbol } from '../src/proto3SymbolProvider';

// Relative to output directory.
const fixtures = path.resolve(__dirname, '../../test/proto');

const fixtureText = (file: string) => {
  const filePath = path.join(fixtures, file);
  return fs.readFileSync(filePath, 'utf8');
};

suite('Proto3DocumentSymbolProvider Tests', () => {
  const testSyms = (syms: vscode.DocumentSymbol[], wantDefs: SymDef[]) => {
    const gotDefs = documentSymsToDefs(syms);
    chai.expect(gotDefs).to.deep.equal(wantDefs);
  };

  test('parseDocumentSybols proto3', () => {
    const text = fixtureText('proto3.proto');
    testSyms(parseDocumentSymbol(text), [
      sym('FooService', 7, 'service', { end: 12 }, [
        sym('DoBar', 8, 'rpc(Foo) returns (Bar)'),
        sym('DoBaz', 9, 'rpc(Foo) returns (Baz)', { end: 11 }),
      ]),
      sym('Foo', 18, 'message'),
      sym('Bar', 20, 'message', { end: 22 }, [sym('i32', 21, 'int32')]),
      sym('Baz', 24, 'message', { end: 52 }, [
        sym('NestedEnum', 31, 'enum', { end: 35 }, [
          sym('NULL', 32, ''),
          sym('ONE', 33, ''),
          sym('TWO', 34, ''),
        ]),
        sym('NestedMessage', 37, 'message', { end: 39 }, [
          sym('b', 38, 'bool'),
        ]),
        sym('f', 41, 'float'),
        sym('nm', 42, 'NestedMessage'),
        sym('oneval', 43, 'oneof', { end: 46 }, [
          sym('oneval_a', 44, 'int32'),
          sym('oneval_b', 45, 'int64'),
        ]),
        sym('b', 50, 'optional bytes'),
        sym('m', 51, 'map<int32, string>'),
      ]),
    ]);
  });
});

type SymDef = {
  name: string;
  line: number;
  detail: string;
  range: { start: number; end: number };
  children: SymDef[];
};

type Range = { start: number; end: number };

const sym = (
  name: string,
  line: number,
  detail: string,
  { start = line, end = line }: Partial<Range> = {},
  children: SymDef[] = []
): SymDef => {
  return {
    name,
    line,
    children,
    detail,
    range: { start, end },
  };
};

function documentSymsToDefs(syms: vscode.DocumentSymbol[]): SymDef[] {
  return syms.map((sym) => {
    const children = documentSymsToDefs(sym.children);
    return {
      name: sym.name,
      line: sym.selectionRange.start.line + 1,
      detail: sym.detail,
      range: {
        start: sym.range.start.line + 1,
        end: sym.range.end.line + 1,
      },
      children,
    };
  });
}
