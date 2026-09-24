/* Forward-test positions, kept in this browser's localStorage (like the ★
   watchlist). Export/import moves them between browsers or backs them up.
   Shape of one position:
     { id, t, name, sector, addedAt, entryDate, entryPrice, benchEntry,
       stop, signal: { score, quad, sectorRank, rs21, mfi, regime },
       status: "open" | "closed", closedAt?, exitDate?, exitPrice?, benchExit? } */

const FT_KEY = "mft-forward-v1";

const ForwardStore = {
  all() {
    try {
      const list = JSON.parse(localStorage.getItem(FT_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },

  save(list) {
    localStorage.setItem(FT_KEY, JSON.stringify(list));
  },

  open() {
    return this.all().filter(p => p.status === "open");
  },

  openFor(ticker) {
    return this.open().find(p => p.t === ticker) || null;
  },

  add(pos) {
    const list = this.all();
    const id = pos.t + "-" + Date.now().toString(36);
    list.push(Object.assign({ id, status: "open", addedAt: new Date().toISOString() }, pos));
    this.save(list);
    return id;
  },

  close(id, exit) {
    const list = this.all();
    const p = list.find(x => x.id === id);
    if (!p || p.status !== "open") return;
    Object.assign(p, { status: "closed", closedAt: new Date().toISOString() }, exit);
    this.save(list);
  },

  remove(id) {
    this.save(this.all().filter(p => p.id !== id));
  },

  exportJson() {
    return JSON.stringify({ kind: "mft-forward-test", version: 1, exportedAt: new Date().toISOString(), positions: this.all() }, null, 1);
  },

  /** Merge an export into this browser; positions already present (same id) are kept as-is. */
  importJson(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data && data.positions;
    if (!Array.isArray(incoming)) throw new Error("not a forward-test export");
    const valid = incoming.filter(p => p && p.id && p.t && p.entryDate && p.entryPrice > 0);
    const list = this.all();
    const have = new Set(list.map(p => p.id));
    const added = valid.filter(p => !have.has(p.id));
    this.save(list.concat(added));
    return added.length;
  },
};
