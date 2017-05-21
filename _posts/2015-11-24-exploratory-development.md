---
layout: post
title: Exploratory development
---

I have been hacking on an idea for a web application to support discounted cash
flow analysis of investment options. I have got something very basic up and
running, so I thought now would be a good time to share.

[![Deals Listing]({{ site.url }}/images/2015-11-24-exploratory-development/deals-listing.png)]({{ site.url }}/images/2015-11-24-exploratory-development/deals-listing.png)

The application centers on the concept of "deals". A deal is a series of cash
flows within a fixed period of time. A series of cash flows could be used to
describe any sort of financial transaction or arrangement.

[![Edit Deal]({{ site.url }}/images/2015-11-24-exploratory-development/edit-deal.png)]({{ site.url }}/images/2015-11-24-exploratory-development/edit-deal.png)

Currently, a deal has:

- a start date;
- an end date;
- a discount period (currently day, week, month or year), and;
- a discount rate (in [basis
  points](https://en.wikipedia.org/wiki/Basis_point) per discount period).

The discount rate is used to determine the present value of each individual
cash flow within the deal. The discount period determines how often this rate
is applied across the net cash flows of the deal. More on this later.

[![View Deal]({{ site.url }}/images/2015-11-24-exploratory-development/view-deal.png)]({{ site.url }}/images/2015-11-24-exploratory-development/view-deal.png)

The top-level view of a deal is currently home to a single report, the
Discounted Cash Flows report. This report simply groups the cash flows of the
deal into equal time periods, based upon the discount period setting.

The present value of each period is calculated using the discount rate against
the deal. As you can see from the screenshot, equal cash flows are worth
different amounts after the present value adjustment, with those occurring
farther into the future being worth less in today's dollars.

The Net Present Value (NPV) calculation is simply the sum of all the present
values of the cash flows within this deal. As you can see, "8 Thomas St" would
not be a good investment (at least within the time horizon we have defined
here), as it would result in us losing over $19,000 in today's dollars.

The next screen is a listing of the individual cash flows that make up the
deal.

[![Cash Flows Listing]({{ site.url }}/images/2015-11-24-exploratory-development/cash-flows-listing.png)]({{ site.url }}/images/2015-11-24-exploratory-development/cash-flows-listing.png)

A cash flow is simply a dollar amount (positive for cash in, negative for cash
out), along with a date and a description. I have not currently abstracted away
the fact that I am working with integer cents in the background, rather than
floats.

[![Edit Cash Flow]({{ site.url }}/images/2015-11-24-exploratory-development/edit-cash-flow.png)]({{ site.url }}/images/2015-11-24-exploratory-development/edit-cash-flow.png)

Cash flows can be both once-off, or recurring. The screen below shows the
current interface for creating a new recurring cash flow.

[![New Recurring Cash Flow]({{ site.url }}/images/2015-11-24-exploratory-development/new-recurring-cash-flow.png)]({{ site.url }}/images/2015-11-24-exploratory-development/new-recurring-cash-flow.png)

A recurring cash flow can have a start date and/or an end date. The absence of
either of these dates will cause it to default back to the start or end date of
the parent deal.

The interval type and the interval multiplier are used to determine the
frequency of the recurring cash flow. For example, a cash flow that occurs
every 2 weeks would have an interval type of "week", and an interval multiplier
of 2. This all needs to be wrapped in a much friendlier user interface, but
this gives you an idea of how it all works under the hood.

Maximum occurrences simply limits the recurring cash flow to a specified number
of instances. This overrides the end date, if the limit is reached before that.

When a recurring cash flow is created, it spawns individual cash flows based on
its parameters. This means that you can selectively edit and delete individual
cash flows, or update the recurrence and have changes flow through.

Changes to the start and end dates of the parent deal are also honoured by
recurring cash flows. For example, if you had an open-ended monthly rent set
up and you changed the deal from spanning 3 years to 5 years, the cash flows
would automatically be updated to span the new period.

I have done a bit of work on an Internal Rate of Return (IRR) report, but there
is still a bit more work to be done on this, and understanding to be gained.

The screens shown in this blog post give you an idea of the basic building
blocks of the application. For this to be useful, there will need to be quite a
few layers of abstraction built on top of this.

For example, it would be useful to have a number of templates that can be used
to assist with the population of cash flows. A template for a rental property
in Queensland might prompt the user for a number of variables (e.g. the loan
terms, deposit amount, estimates on outgoings) before automatically generating
the corresponding cash flows. Important variables might be exposed for
manipulation at the deal level, to enable to user to easily change aspects of
the deal (e.g. the interest rate) and have the effects flow through in reports.

Another feature that I think will be needed is some sort of adjustment that can
be applied to a recurring cash flow. An example of this could be vacancy rate
in the case of a rental property (reduce effective rent by a percentage).
Another rental example could be periodic increases, for example a percentage
increase each year.

I am thinking I will do a "polish" iteration now, removing any technical debt
created so far and creating a proper user interface for the current features.
That should provide a solid base before adding too much more functionality.

Time to get back to it.
