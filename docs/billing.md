# Billing fleets

Depotcharge prices every charge at **the operator's price plus the platform's margin**, then VAT.

- **Operator price**: the charge record's `total_cost` (ex VAT) from the operator, which includes any
  booking fee (`total_reservation_cost`).
- **Margin**: a percentage set by a platform admin on the Network page (Fleet pricing). Each change
  is recorded with the moment it took effect, and every charge is priced at the margin in force when
  it finished, so a new margin never re-prices a month already billed.
- **VAT**: 20%. HMRC treats public charging as standard-rated while it appeals the Charge My Street
  tribunal ruling (Revenue & Customs Brief 4 (2026)). Check with your accountant.

## Monthly statements

Bookings → Monthly statements (`#/statements`) shows, per fleet and calendar month (UK time), every
charge record that ended in the month: the operator price, the margin, the total ex VAT, VAT and the
total. Fleets can print it or download a CSV for accounting software (formulas in cells are
neutralised). API: `GET /api/fleets/{id}/statements/{YYYY-MM}`.

A statement is not a VAT invoice. Raise invoices from it in your accounting software, with your
company and VAT details (Compliance → Company & legal).

Amounts are rounded to the penny per line; totals are sums of the rounded lines, so they always add up.
Charges in another currency than the month's main one are listed as left out.
