"use strict";
const CURRENCIES = { CNY: "人民币 CNY", USD: "美元 USD", JPY: "日元 JPY" };
const SOURCE = "Frankfurter / ECB";
function validCurrency(code) { return Object.hasOwn(CURRENCIES, code); }
function validDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + "T00:00:00Z");
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === date;
}
function snapshot(value, requestedDate = null) {
  if (!value || !validDate(value.date) || (requestedDate && value.date > requestedDate)) throw new Error("汇率日期无效或晚于记账日期");
  if (![SOURCE, "手动"].includes(value.source)) throw new Error("汇率来源无效");
  const rates = { CNY: 1 };
  for (const code of ["USD", "JPY"]) {
    const rate = value.rates?.[code];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1000000 || rate < 0.00000001) throw new Error(`${code} 汇率须为有效正数`);
    rates[code] = rate;
  }
  return { date: value.date, source: value.source, rates };
}
// Decimal rational arithmetic avoids binary floating-point rounding of converted cents.
function fraction(value) {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const parts = mantissa.split("."), places = (parts[1]?.length || 0) - Number(exponent);
  const n = BigInt(parts.join(""));
  return places >= 0 ? [n, 10n ** BigInt(places)] : [n * 10n ** BigInt(-places), 1n];
}
function convert(cents, from, to, fx) {
  if (!Number.isSafeInteger(cents) || !validCurrency(from) || !validCurrency(to)) throw new Error("金额或币种无效");
  if (from === to) return cents;
  const rates = snapshot(fx).rates;
  const [a, b] = fraction(rates[to]), [c, d] = fraction(rates[from]);
  const numerator = BigInt(Math.abs(cents)) * a * d, denominator = b * c;
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  const result = Number(rounded) * (cents < 0 ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw new Error("换算金额超出安全范围");
  return result;
}
function amount(record, field, target = "CNY") {
  return record[field] == null ? null : convert(record[field], record.currency || "CNY", target, field === "currentValueCents" ? record.valuationFx : record.fx);
}
function money(cents, currency = "CNY", integer = false) {
  if (!Number.isSafeInteger(cents) || !validCurrency(currency)) throw new Error("金额或币种无效");
  const magnitude = integer ? Math.ceil(Math.abs(cents) / 100) : Math.floor(Math.abs(cents) / 100);
  const whole = String(magnitude).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const suffix = integer ? "" : `.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
  const prefix = { CNY: "¥", USD: "$", JPY: "JP¥" }[currency];
  return `${prefix}${cents < 0 ? "−" : ""}${whole}${suffix}`;
}
class ExchangeRates {
  constructor(request, cache = {}, persist = async () => {}, today = () => new Date().toISOString().slice(0, 10)) {
    this.request = request; this.cache = cache; this.persist = persist; this.today = today; this.pending = new Map();
  }
  async get(date) {
    if (!validDate(date) || date < "1999-01-04") throw new Error("自动汇率支持 1999-01-04 起的日期；其他日期可手动填写汇率");
    const today = this.today(), requested = date > today ? today : date;
    const cached = this.cache[requested];
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    // Recheck quotes returned before publication on the next day. A fresh lookup
    // a week later can settle weekend/holiday dates without endless requests.
    const checkedOn = cached?.checkedOn;
    const settled = requested < today && (cached?.date === requested
      || (validDate(checkedOn) && checkedOn <= today
        && Date.parse(checkedOn + "T00:00:00Z") - Date.parse(requested + "T00:00:00Z") >= 7 * 86400000));
    const recent = checkedOn === today && age >= 0 && age < (requested === today ? 3600000 : 86400000);
    if (cached && (settled || recent)) {
      try { return snapshot(cached, requested); } catch (_) { /* Refetch invalid cache entries. */ }
    }
    if (this.pending.has(requested)) return this.pending.get(requested);
    const operation = this.fetch(requested).catch(error => {
      if (cached) { try { return { ...snapshot(cached, requested), cached: true }; } catch (_) {} }
      throw new Error(`汇率暂时无法获取，请联网重试或手动填写（${error.message}）`);
    }).finally(() => this.pending.delete(requested));
    this.pending.set(requested, operation); return operation;
  }
  async fetch(date) {
    const url = `https://api.frankfurter.dev/v2/providers/ecb/rates?base=CNY&quotes=USD,JPY&date=${date}`;
    const response = await this.request(url);
    if (!Array.isArray(response) || response.length !== 2) throw new Error("汇率服务返回的数据不完整");
    const rates = {}, dates = new Set();
    for (const row of response) {
      if (row.base !== "CNY" || !["USD", "JPY"].includes(row.quote) || Object.hasOwn(rates, row.quote)) throw new Error("汇率币种不匹配");
      rates[row.quote] = row.rate; dates.add(row.date);
    }
    if (dates.size !== 1) throw new Error("两种货币的汇率日期不同");
    const fx = snapshot({ date: [...dates][0], source: SOURCE, rates }, date);
    this.cache[date] = { ...fx, fetchedAt: Date.now(), checkedOn: this.today() };
    // A failed cache write must not turn a valid quote into an invented fallback.
    await this.persist(this.cache);
    return fx;
  }
}
module.exports = { CURRENCIES, SOURCE, validCurrency, snapshot, convert, amount, money, ExchangeRates };
