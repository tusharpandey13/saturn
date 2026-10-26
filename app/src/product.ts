// The product name, from the single constant in product.json (a rename edits that file only).
import product from "../../product.json" with { type: "json" };

export const PRODUCT_NAME: string = product.name;
export const PRODUCT_SLUG: string = product.slug;
