"use strict";

// Parse arithmetic directly; calculator input is never executed as JavaScript.
function evaluateExpression(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("请先输入算式");
  if (input.length > 200) throw new Error("算式太长，请控制在 200 个字符以内");
  const source = input.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  let position = 0;
  const skip = () => { while (/\s/.test(source[position] || "") && position < source.length) position++; };
  const finite = value => {
    if (!Number.isFinite(value)) throw new Error("结果超出计算范围");
    return value;
  };
  function factor() {
    skip();
    const char = source[position];
    if (char === "+" || char === "-") {
      position++;
      return char === "-" ? -factor() : factor();
    }
    if (char === "(") {
      position++;
      const value = expression();
      skip();
      if (source[position] !== ")") throw new Error("请检查括号是否成对");
      position++;
      return value;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(position));
    if (!number) throw new Error("请输入完整算式，仅支持数字、括号和加减乘除");
    position += number[0].length;
    return finite(Number(number[0]));
  }
  function term() {
    let value = factor();
    while (true) {
      skip();
      const operator = source[position];
      if (operator !== "*" && operator !== "/") return value;
      position++;
      const next = factor();
      if (operator === "/" && next === 0) throw new Error("不能除以 0");
      value = finite(operator === "*" ? value * next : value / next);
    }
  }
  function expression() {
    let value = term();
    while (true) {
      skip();
      const operator = source[position];
      if (operator !== "+" && operator !== "-") return value;
      position++;
      const next = term();
      value = finite(operator === "+" ? value + next : value - next);
    }
  }
  const result = expression();
  skip();
  if (position !== source.length) throw new Error("请检查算式，仅支持数字、括号和加减乘除");
  // Keep ordinary decimals readable, including 0.1 + 0.2, and normalize -0.
  return finite(Number(result.toPrecision(15))).toString();
}

module.exports = { evaluateExpression };
