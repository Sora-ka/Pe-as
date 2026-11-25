const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://localhost/rotapecas';
const db = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  idleTimeoutMillis: 10000
});
db.on('error', () => {});
const um = async (sql, args) => (await db.query(sql, args)).rows[0].j;

let cache = null;
let cacheEm = 0;

const rotas = {
  'GET /api/catalogo': async () => {
    if (!cache || Date.now() - cacheEm > 30000) {
      cache = await um('SELECT catalogo_json() AS j');
      cacheEm = Date.now();
    }
    return cache;
  },
  'GET /api/busca': (u) =>
    um('SELECT busca_json($1, $2, $3::smallint, $4, $5::int) AS j', [
      u.get('q') || '', u.get('modelo'), u.get('ano'), u.get('motor'),
      Math.min(+u.get('limite') || 700, 700)
    ]),
  'GET /api/mais-buscadas': () =>
    um(`SELECT coalesce(jsonb_agg(jsonb_build_object('q', m.consulta, 'n', m.vezes) ORDER BY m.vezes DESC, m.ultima DESC), '[]') AS j
          FROM mais_buscadas(30, 6) m`),
  'POST /api/busca': async (u, b) => {
    await db.query('SELECT registrar_busca($1, $2::int, $3, $4::int)', [b.q, b.n, b.sessao, b.cliente]);
    return { ok: true };
  },
  'POST /api/evento': async (u, b) => {
    await db.query('SELECT registrar_evento($1, $2, $3, $4, $5::int)', [b.acao, b.codigo, b.consulta || '', b.sessao, b.cliente]);
    return { ok: true };
  },
  'POST /api/entrar': (u, b) => um('SELECT entrar_cliente($1, $2) AS j', [b.email, b.nome]),
  'PUT /api/garagem': async (u, b) => {
    await db.query('SELECT salvar_garagem($1::int, $2::jsonb)', [b.cliente, JSON.stringify(b.carros || [])]);
    return { ok: true };
  },
  'POST /api/pedidos': async (u, b) => {
    const r = await um('SELECT criar_pedido($1::int, $2::jsonb) AS j', [b.cliente, JSON.stringify(b.itens || [])]);
    cache = null;
    return r;
  }
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const rota = rotas[req.method + ' ' + u.pathname];
  if (!rota) {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    res.writeHead(404);
    return res.end();
  }
  try {
    let b = {};
    if (req.method !== 'GET') {
      let t = '';
      for await (const c of req) {
        t += c;
        if (t.length > 1e5) throw new Error('corpo grande');
      }
      b = t ? JSON.parse(t) : {};
    }
    const r = await rota(u.searchParams, b);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(r));
  } catch (e) {
    const regra = e.code === 'P0001';
    res.writeHead(regra ? 409 : 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: regra ? e.message : 'erro interno' }));
  }
}).listen(process.env.PORT || 3000);
