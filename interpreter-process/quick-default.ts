import { getQuickJS } from "quickjs-emscripten";

const module = await getQuickJS();
using vm = module.newContext();
using result = vm.evalCode("1 + 1");
if (result.error) throw Error(JSON.stringify(vm.dump(result.error)));
console.log(JSON.stringify({ bun: Bun.version, value: vm.getNumber(result.value) }));
