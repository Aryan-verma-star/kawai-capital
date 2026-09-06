import { db } from "../src/lib/db";

const rows = await db.aiCall.groupBy({
  by: ["callDate", "role", "outcome"],
  _count: { _all: true },
  orderBy: { callDate: "desc" },
  take: 60,
});
for (const r of rows) {
  console.log(
    `${r.callDate}  ${r.role.padEnd(9)} ${r.outcome.padEnd(13)} ${r._count._all}`
  );
}
const latest = rows[0]?.callDate;
const total = await db.aiCall.count({ where: { callDate: latest } });
console.log(`\ntotal on latest IST date ${latest}: ${total}`);
