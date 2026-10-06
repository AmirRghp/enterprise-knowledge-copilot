export const invoiceStatuses = ["All", "Unpaid", "Due soon", "Paid"];
export function invoiceSummary(rows) {
  const totals = { paid: 0, dueSoon: 0, unpaid: 0 };
  for (const row of rows) {
    const key = row.status === "Paid" ? "paid" : row.status === "Due soon" ? "dueSoon" : "unpaid";
    totals[key] += row.amount;
  }
  return { ...totals, billed: totals.paid + totals.dueSoon + totals.unpaid };
}
export function filterInvoices(rows, status, search = "", formatAmount = String) {
  const term = search.trim().toLowerCase();
  return rows.filter(row => (status === "All" || (status === "Unpaid"
    ? ["Outstanding", "Overdue"].includes(row.status) : row.status === status))
    && (!term || [row.customer, row.region, row.dueDate, row.contact,
      row.status === "Outstanding" ? "Unpaid" : row.status, formatAmount(row.amount)]
      .some(value => String(value).toLowerCase().includes(term))));
}
