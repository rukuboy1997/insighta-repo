const { Router } = require("express");
const pool = require("../../db");

const router = Router();

const VALID_SORT_BY = ["age", "created_at", "gender_probability"];
const VALID_ORDER = ["asc", "desc"];
const VALID_GENDERS = ["male", "female"];
const VALID_AGE_GROUPS = ["child", "teenager", "adult", "senior"];

function isFloat(val) { return /^-?\d+(\.\d+)?$/.test(val); }
function isPositiveInt(val) { return /^\d+$/.test(val) && parseInt(val, 10) > 0; }
function isNonNegativeInt(val) { return /^\d+$/.test(val); }

function buildFilters(query) {
  const {
    gender, age_group, country_id, min_age, max_age,
    min_gender_probability, min_country_probability,
    sort_by = "created_at", order = "asc", page = "1", limit = "10",
  } = query;

  const errors = [];
  if (gender !== undefined && !VALID_GENDERS.includes(gender)) errors.push("gender");
  if (age_group !== undefined && !VALID_AGE_GROUPS.includes(age_group)) errors.push("age_group");
  if (!VALID_SORT_BY.includes(sort_by)) errors.push("sort_by");
  if (!VALID_ORDER.includes(order)) errors.push("order");
  if (min_age !== undefined && !isNonNegativeInt(min_age)) errors.push("min_age");
  if (max_age !== undefined && !isNonNegativeInt(max_age)) errors.push("max_age");
  if (min_gender_probability !== undefined && !isFloat(min_gender_probability)) errors.push("min_gender_probability");
  if (min_country_probability !== undefined && !isFloat(min_country_probability)) errors.push("min_country_probability");
  if (!isPositiveInt(page)) errors.push("page");
  if (!isPositiveInt(limit)) errors.push("limit");

  if (errors.length) return { error: "Invalid query parameters" };

  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 50);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (gender) { conditions.push(`gender = $${idx++}`); values.push(gender); }
  if (age_group) { conditions.push(`age_group = $${idx++}`); values.push(age_group); }
  if (country_id) { conditions.push(`country_id = $${idx++}`); values.push(country_id.toUpperCase()); }
  if (min_age !== undefined) { conditions.push(`age >= $${idx++}`); values.push(parseInt(min_age, 10)); }
  if (max_age !== undefined) { conditions.push(`age <= $${idx++}`); values.push(parseInt(max_age, 10)); }
  if (min_gender_probability !== undefined) { conditions.push(`gender_probability >= $${idx++}`); values.push(parseFloat(min_gender_probability)); }
  if (min_country_probability !== undefined) { conditions.push(`country_probability >= $${idx++}`); values.push(parseFloat(min_country_probability)); }

  const sortCol = sort_by === "gender_probability" ? "gender_probability" : sort_by === "age" ? "age" : "created_at";

  return { pageNum, limitNum, offset, conditions, values, sortCol, order, idx };
}

const SELECT_COLS = `id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;

// GET /api/v2/profiles
router.get("/", async (req, res) => {
  const result = buildFilters(req.query);
  if (result.error) {
    return res.status(422).json({ status: "error", message: result.error });
  }

  const { pageNum, limitNum, offset, conditions, values, sortCol, order, idx } = result;
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM profiles ${where}`, values),
      pool.query(
        `SELECT ${SELECT_COLS} FROM profiles ${where} ORDER BY ${sortCol} ${order.toUpperCase()}
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...values, limitNum, offset]
      ),
    ]);
    const total = parseInt(countRes.rows[0].count, 10);
    return res.json({
      status: "success",
      data: dataRes.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
        has_next: pageNum * limitNum < total,
        has_prev: pageNum > 1,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// GET /api/v2/profiles/export  — CSV download
router.get("/export", async (req, res) => {
  const result = buildFilters({ ...req.query, limit: "2026", page: "1" });
  if (result.error) {
    return res.status(422).json({ status: "error", message: result.error });
  }

  const { conditions, values, sortCol, order, idx } = result;
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const dataRes = await pool.query(
      `SELECT ${SELECT_COLS} FROM profiles ${where} ORDER BY ${sortCol} ${order.toUpperCase()}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, 2026, 0]
    );

    const header = "id,name,gender,gender_probability,age,age_group,country_id,country_name,country_probability,created_at\r\n";
    const rows = dataRes.rows.map((r) =>
      [r.id, `"${r.name.replace(/"/g, '""')}"`, r.gender, r.gender_probability, r.age, r.age_group,
       r.country_id, `"${r.country_name}"`, r.country_probability, r.created_at].join(",")
    ).join("\r\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"profiles.csv\"");
    return res.send(header + rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// ---- Natural Language Parser (same logic as v1) ----
const COUNTRY_MAP = {
  nigeria: "NG", ghana: "GH", kenya: "KE", ethiopia: "ET", tanzania: "TZ",
  uganda: "UG", rwanda: "RW", mozambique: "MZ", angola: "AO", zambia: "ZM",
  malawi: "MW", zimbabwe: "ZW", "south africa": "ZA", mali: "ML", senegal: "SN",
  cameroon: "CM", "ivory coast": "CI", "cote d'ivoire": "CI", "côte d'ivoire": "CI",
  gabon: "GA", "democratic republic of the congo": "CD", "dr congo": "CD",
  congo: "CG", "republic of the congo": "CG", sudan: "SD", morocco: "MA",
  madagascar: "MG", namibia: "NA", eritrea: "ER", gambia: "GM",
  "cape verde": "CV", "burkina faso": "BF", "guinea-bissau": "GW", guinea: "GN",
  benin: "BJ", togo: "TG", niger: "NE", chad: "TD",
  "central african republic": "CF", somalia: "SO", djibouti: "DJ", comoros: "KM",
  mauritius: "MU", "sierra leone": "SL", liberia: "LR",
  "equatorial guinea": "GQ", burundi: "BI", "south sudan": "SS",
  egypt: "EG", libya: "LY", tunisia: "TN", algeria: "DZ",
  india: "IN", brazil: "BR", france: "FR", "united kingdom": "GB",
  uk: "GB", "united states": "US", usa: "US",
};

function parseNL(q) {
  const lower = q.toLowerCase().trim();
  if (!lower) return null;
  const f = {};
  let matched = false;

  if (/\bmales?\b/.test(lower) && !/\bfemales?\b/.test(lower)) { f.gender = "male"; matched = true; }
  else if (/\bfemales?\b/.test(lower)) { f.gender = "female"; matched = true; }
  else if (/\bwomen\b|\bwoman\b|\bgirls?\b/.test(lower)) { f.gender = "female"; matched = true; }
  else if (/\bmen\b|\bman\b|\bboys?\b/.test(lower)) { f.gender = "male"; matched = true; }
  if (/\bmale and female\b|\bfemale and male\b|\bboth\b/.test(lower)) delete f.gender;

  if (/\bchildren\b|\bchild\b|\bkids?\b/.test(lower)) { f.age_group = "child"; matched = true; }
  else if (/\bteenagers?\b|\bteens?\b/.test(lower)) { f.age_group = "teenager"; matched = true; }
  else if (/\badults?\b/.test(lower)) { f.age_group = "adult"; matched = true; }
  else if (/\bseniors?\b|\belderly\b|\bold people\b/.test(lower)) { f.age_group = "senior"; matched = true; }

  if (/\byoung\b/.test(lower) && !f.age_group) { f.min_age = 16; f.max_age = 24; matched = true; }

  const above = lower.match(/(?:above|over|older than|more than|greater than)\s+(\d+)/);
  if (above) { f.min_age = parseInt(above[1], 10); matched = true; }
  const below = lower.match(/(?:below|under|younger than|less than)\s+(\d+)/);
  if (below) { f.max_age = parseInt(below[1], 10); matched = true; }
  const between = lower.match(/between\s+(\d+)\s+and\s+(\d+)/);
  if (between) { f.min_age = parseInt(between[1], 10); f.max_age = parseInt(between[2], 10); matched = true; }
  const aged = lower.match(/\baged?\s+(\d+)/);
  if (aged) { const a = parseInt(aged[1], 10); f.min_age = a; f.max_age = a; matched = true; }

  const sorted = Object.entries(COUNTRY_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [name, code] of sorted) {
    if (lower.includes(name)) { f.country_id = code; matched = true; break; }
  }

  return matched ? f : null;
}

// GET /api/v2/profiles/search
router.get("/search", async (req, res) => {
  const { q, page = "1", limit = "10" } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
  }
  if (!isPositiveInt(page) || !isPositiveInt(limit)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }

  const filters = parseNL(q);
  if (!filters) {
    return res.status(200).json({ status: "error", message: "Unable to interpret query" });
  }

  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 50);
  const offset = (pageNum - 1) * limitNum;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (filters.gender) { conditions.push(`gender = $${idx++}`); values.push(filters.gender); }
  if (filters.age_group) { conditions.push(`age_group = $${idx++}`); values.push(filters.age_group); }
  if (filters.country_id) { conditions.push(`country_id = $${idx++}`); values.push(filters.country_id); }
  if (filters.min_age !== undefined) { conditions.push(`age >= $${idx++}`); values.push(filters.min_age); }
  if (filters.max_age !== undefined) { conditions.push(`age <= $${idx++}`); values.push(filters.max_age); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM profiles ${where}`, values),
      pool.query(
        `SELECT ${SELECT_COLS} FROM profiles ${where} ORDER BY created_at ASC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...values, limitNum, offset]
      ),
    ]);
    const total = parseInt(countRes.rows[0].count, 10);
    return res.json({
      status: "success",
      data: dataRes.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
        has_next: pageNum * limitNum < total,
        has_prev: pageNum > 1,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

module.exports = router;
