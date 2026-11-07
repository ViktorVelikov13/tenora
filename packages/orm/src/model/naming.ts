/** How a model's attribute names map to column names and back. */
export type NamingStrategy = {
  /** "createdAt" → "created_at" */
  toColumn(attribute: string): string;
  /** "created_at" → "createdAt" */
  toAttribute(column: string): string;
};

/** "createdAt" → "created_at", "userID" → "user_id", "HTMLParser" → "html_parser"; snake_case input is unchanged. */
export const snakeCase = (name: string): string =>
  name
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

/**
 * "created_at" → "createdAt". Only an underscore before a lowercase letter goes, so the result maps back to the same
 * column: "address_2" stays "address_2" rather than becoming "address2", which would map back to "address2".
 */
export const camelCase = (name: string): string => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const naming = {
  /** camelCase attributes, snake_case columns: the default */
  snakeCase: { toColumn: snakeCase, toAttribute: camelCase } satisfies NamingStrategy,
  /** attributes named exactly like their columns */
  none: { toColumn: (name: string) => name, toAttribute: (name: string) => name } satisfies NamingStrategy,
};

const IRREGULAR: Record<string, string> = {
  person: "people",
  man: "men",
  woman: "women",
  child: "children",
  tooth: "teeth",
  foot: "feet",
  mouse: "mice",
  goose: "geese",
  ox: "oxen",
};

const UNCOUNTABLE = new Set([
  "data",
  "equipment",
  "information",
  "metadata",
  "media",
  "money",
  "news",
  "series",
  "species",
  "feedback",
  "staff",
]);

/** English plural of one lowercase word, for default table names. Set `static table` for anything unusual. */
const pluralWord = (word: string): string => {
  if (UNCOUNTABLE.has(word)) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

/** The default table of a model class: the snake_case plural of its name, "OrderItem" → "order_items". */
export const defaultTableName = (className: string): string => {
  const words = snakeCase(className).split("_");
  words[words.length - 1] = pluralWord(words[words.length - 1]);
  return words.join("_");
};
