export const loopBody = "while (true) {}";
export const asyncLoopBody = "return await (async () => { await Promise.resolve(); while (true) {} })();";
export const regexBody = "return /(a+)+$/.test('a'.repeat(30) + 'b');";
export const memoryBody = "const data = []; let i = 0; while (true) { data.push((String(i++) + ':').repeat(1024)); }";

export const view = `const theme = { tone: "neutral", background: "#fff" };
const verbs = ["Open", "Read", "Write", "Close"];
const kinds = ["label", "button", "text", "badge"];
function item(row, column) {
  const index = row * 9 + column;
  const action = verbs[index % verbs.length];
  const type = kinds[index % kinds.length];
  const active = index % 3 === 0;
  const state = active ? "active" : "idle";
  const id = "item-" + index;
  return {
    id,
    type,
    label: action + " " + index,
    props: {
      state,
      active,
      weight: index % 5,
    },
    children: [],
  };
}

function group(row) {
  const children = [];
  for (let column = 0; column < 9; column++) {
    children.push(item(row, column));
  }
  return {
    id: "group-" + row,
    type: "row",
    label: "Row " + (row + 1),
    props: { gap: 4, align: "start" },
    children,
  };
}

const groups = [];
for (let row = 0; row < 19; row++) {
  groups.push(group(row));
}
const last = group(19);
last.children.pop();
groups.push(last);
return {
  id: "root",
  type: "view",
  props: { theme, title: "Dashboard" },
  children: groups,
};`;

export const language = {
  asyncAwait: ["return await (async () => { const a = await Promise.resolve(3); return a + 1; })();", 4],
  destructuring: ["const {a: [b, c = 2]} = {a: [3]}; return b + c;", 5],
  optionalChaining: ["const obj = {a: null}; return obj.a?.b ?? 7;", 7],
  Map: ["const m = new Map([[1, 2]]); m.set(2, 3); return m.get(1) + m.get(2) + m.size;", 7],
  JSON: ["return JSON.stringify(JSON.parse('{\"a\":[1,true]}'));", '{"a":[1,true]}'],
  Date: ["return new Date(Date.UTC(2020, 0, 2)).toISOString();", "2020-01-02T00:00:00.000Z"],
  Intl: ["return new Intl.NumberFormat('en-US').format(1234);", "1,234"],
  templateLiterals: ['const n = 3; return `value ${n + 1}`;', "value 4"],
  classes: ["class A { m() { return 1; } } class B extends A { n = 2; m() { return super.m() + this.n; } } return new B().m();", 3],
} as const;

export const arrayMethods: Record<string, [string, unknown]> = {
  at: ["a.at(-1)", 2],
  concat: ["a.concat([4])", [3, 1, 2, 4]],
  copyWithin: ["a.copyWithin(1, 0, 2)", [3, 3, 1]],
  entries: ["[...a.entries()]", [[0, 3], [1, 1], [2, 2]]],
  every: ["a.every(x => x > 0)", true],
  fill: ["a.fill(9, 1)", [3, 9, 9]],
  filter: ["a.filter(x => x % 2)", [3, 1]],
  find: ["a.find(x => x < 3)", 1],
  findIndex: ["a.findIndex(x => x < 3)", 1],
  findLast: ["a.findLast(x => x < 3)", 2],
  findLastIndex: ["a.findLastIndex(x => x < 3)", 2],
  flat: ["[a, [4]].flat()", [3, 1, 2, 4]],
  flatMap: ["a.flatMap(x => [x, x])", [3, 3, 1, 1, 2, 2]],
  forEach: ["(a.forEach(x => sum += x), sum)", 6],
  includes: ["a.includes(2)", true],
  indexOf: ["a.indexOf(1)", 1],
  join: ["a.join(':')", "3:1:2"],
  keys: ["[...a.keys()]", [0, 1, 2]],
  lastIndexOf: ["[3, 1, 3].lastIndexOf(3)", 2],
  map: ["a.map(x => x * 2)", [6, 2, 4]],
  pop: ["[a.pop(), a]", [2, [3, 1]]],
  push: ["[a.push(4), a]", [4, [3, 1, 2, 4]]],
  reduce: ["a.reduce((x,y) => x - y)", 0],
  reduceRight: ["a.reduceRight((x,y) => x - y)", -2],
  reverse: ["a.reverse()", [2, 1, 3]],
  shift: ["[a.shift(), a]", [3, [1, 2]]],
  slice: ["a.slice(1)", [1, 2]],
  some: ["a.some(x => x === 2)", true],
  sort: ["a.sort((x,y) => x-y)", [1, 2, 3]],
  splice: ["[a.splice(1, 1, 4), a]", [[1], [3, 4, 2]]],
  toLocaleString: ["a.toLocaleString('en-US')", "3,1,2"],
  toReversed: ["[a.toReversed(), a]", [[2, 1, 3], [3, 1, 2]]],
  toSorted: ["[a.toSorted((x,y) => x-y), a]", [[1, 2, 3], [3, 1, 2]]],
  toSpliced: ["[a.toSpliced(1, 1, 4), a]", [[3, 4, 2], [3, 1, 2]]],
  toString: ["a.toString()", "3,1,2"],
  unshift: ["[a.unshift(4), a]", [4, [4, 3, 1, 2]]],
  values: ["[...a.values()]", [3, 1, 2]],
  with: ["[a.with(1, 4), a]", [[3, 4, 2], [3, 1, 2]]],
  "[Symbol.iterator]": ["[...a]", [3, 1, 2]],
};
