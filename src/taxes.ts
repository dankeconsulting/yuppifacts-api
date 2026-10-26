import { z } from "zod";
import { ApiError } from "./contracting.js";
import { query } from "./db.js";

export const taxCountryCode = z.enum(["MX", "CR", "CO"]);
export const taxRateUpdateInput = z.object({
  countryCode: taxCountryCode,
  ivaBps: z.number().int().min(0).max(10000),
});

type TaxRow = { country_code: "MX" | "CR" | "CO"; iva_bps: number };
const countries: Array<z.infer<typeof taxCountryCode>> = ["MX", "CR", "CO"];

export async function listTaxRates() {
  const result = await query<TaxRow>("SELECT country_code, iva_bps FROM country_tax_rates ORDER BY country_code");
  const configured = new Map(result.rows.map((row) => [row.country_code, row.iva_bps]));
  return countries.map((countryCode) => ({
    countryCode,
    ivaBps: configured.get(countryCode) ?? 0,
  }));
}

export async function taxRateFor(countryCode: z.infer<typeof taxCountryCode>) {
  const result = await query<TaxRow>("SELECT country_code, iva_bps FROM country_tax_rates WHERE country_code = $1", [countryCode]);
  return result.rows[0]?.iva_bps ?? 0;
}

export async function deleteTaxRate(countryCode: z.infer<typeof taxCountryCode>) {
  await query("DELETE FROM country_tax_rates WHERE country_code = $1", [countryCode]);
  return { countryCode, ivaBps: 0 };
}

export async function updateTaxRate(input: z.infer<typeof taxRateUpdateInput>) {
  const result = await query<TaxRow>(
    `INSERT INTO country_tax_rates(country_code, iva_bps) VALUES($1, $2)
     ON CONFLICT(country_code) DO UPDATE SET iva_bps = EXCLUDED.iva_bps, updated_at = now()
     RETURNING country_code, iva_bps`,
    [input.countryCode, input.ivaBps],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(500, "No fue posible actualizar el impuesto.");
  return { countryCode: row.country_code, ivaBps: row.iva_bps };
}
