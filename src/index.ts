export interface Env {
	DB: D1Database;
	API_KEY: string;
}

function norm(s: string) {
	return s.trim().toUpperCase();
}

// Prefer displacement like 3.6L; avoid grabbing V6 = 6
function parseEngineSize(engine?: string | null): number | null {
	if (!engine) return null;
	const t = engine.toUpperCase();

	const mL = t.match(/(\d(?:\.\d)?)\s*L/); // 2.0L, 3.6L, 5L
	if (mL?.[1]) return Number(mL[1]);

	const mDec = t.match(/(\d+\.\d+)/); // 3.5
	if (mDec?.[1]) return Number(mDec[1]);

	return null;
}

function buildKey(params: {
	brand: string;
	year: number;
	make: string;
	model: string;
	engine?: string | null;
}) {
	return `${params.brand}|${params.year}|${params.make}|${params.model}|${params.engine || ""}`;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		// Simple API key auth
		if (req.headers.get("x-api-key") !== env.API_KEY) {
			return new Response("Unauthorized", { status: 401 });
		}

		const url = new URL(req.url);

		// Health check
		if (url.pathname === "/health") {
			return Response.json({ ok: true });
		}

		// Filter lookup
		if (url.pathname === "/v1/filters") {
			const brand = norm(url.searchParams.get("brand") || "PENNZOIL");
			const year = Number(url.searchParams.get("year"));
			const make = norm(url.searchParams.get("make") || "");
			const model = norm(url.searchParams.get("model") || "");
			const engine = url.searchParams.get("engine");

			if (!year || !make || !model) {
				return new Response("Bad request. Need year, make, model.", { status: 400 });
			}

			const engineSize = parseEngineSize(engine);
			const requestKey = buildKey({ brand, year, make, model, engine });

			// Lookup
			const result = await env.DB.prepare(
				`
        SELECT * FROM filter_fitments
        WHERE brand = ?
          AND make = ?
          AND model = ?
          AND year_from <= ?
          AND year_to >= ?
        ORDER BY confidence DESC
        LIMIT 20
        `
			)
				.bind(brand, make, model, year, year)
				.all();

			if (result.results.length > 0) {
				return Response.json({
					ok: true,
					status: "hit",
					requestKey,
					results: result.results,
				});
			}

			// Log miss
			await env.DB.prepare(
				`
        INSERT OR IGNORE INTO miss_logs
        (request_key, brand, year, make, model, engine_text, engine_size_l)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `
			)
				.bind(requestKey, brand, year, make, model, engine, engineSize)
				.run();

			return Response.json({
				ok: true,
				status: "queued",
				requestKey,
			});
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
