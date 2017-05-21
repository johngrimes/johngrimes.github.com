---
layout: post
title: Embracing the craft
---

There is nothing more rewarding that taking the bull by the horns and using
foundation software development tools to create something amazing.

This is a joy that we are unfortunately often sheltered from by the "best
practice" use of a plethora of frameworks, libraries and abstraction layers
that we are trained to place between ourselves as developers and our foundation
tools.

What do I mean by foundation tools?

* Operating systems (e.g. [Linux](http://linux.die.net/man/))
* Transport protocols (e.g. [HTTP](https://tools.ietf.org/html/rfc2616),
  [HTTP/2](https://tools.ietf.org/html/rfc7540))
* Programming languages (e.g. [Ruby](http://ruby-doc.com/docs/ProgrammingRuby/))
* Web standards (e.g. [HTML](http://www.w3.org/TR/html/),
  [CSS](http://www.w3.org/TR/css-2010/),
  [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript),
  [DOM](https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model),
  [SVG](http://www.w3.org/TR/SVG11/))

### External dependencies own you

Dependency proliferation is one of the biggest (and most subversive) problems
with the way software development is undertaken in modern times.

The design-time cost of adding a library or framework dependency to a project
is so low that external dependencies are often added without a lot of
consideration for the hidden consequences of this. This is paired with the fact
that the ecosystem is so strong for many languages that almost every feature
you can think of exists as freely available component, just itching to be added
to your dependency manifest.

Here is the first situation I want to talk about:

> Developer wants to add some functionality to an application. Developer knows
> of a library that does this. Developer automatically adds this library to
> the dependency list. Refrains of "Why reinvent the wheel?" are often heard.

There is clearly a balance to be struck here. Unfortunately you cannot possibly
weigh that decision without understanding and carefully analysing the proposed
dependency, and asking some of the following questions:

1. Does this solution fit my use case, or would I need to make compromises
   within my product to fit the ready-made solution?
2. How heavy is the dependency in terms of complexity / lines of code?
3. Does the dependency cover off a whole bunch of other use cases that I have
   no intention of ever using?
4. How much time and mind space will I need to spend learning the API and
   configuration relating to the new dependency?
5. What would be the effort and complexity involved in custom coding the
   feature using foundation tools? (note that you can't know this unless you
   have an in-depth understanding of the foundation tools)

> Developer wants to be "productive", maybe even a "10x'er". Developer uses
> all the fashionable abstraction layers that they possibly can to help
> achieve this goal.

There have been a proliferation of frameworks and abstraction layers over every
type of foundation tool in recent years. In some cases this has been very
useful and progressive, and has served real practical purposes (e.g.
cross-platform/browser compatibility). In other cases, these layers have not
served much purpose beyond some vague idea of "programmer productivity /
happiness".

We could take [jQuery](https://jquery.com/) as an example. In the beginning,
there were some great and very compelling reasons to use jQuery on web
projects. It ironed out a lot of cross-browser compatibility issues, and it
exposed methods that covered up the horrible landscape of AJAX APIs within
browsers. These days, it is not as compelling. A lot of the problems that
jQuery addresses have now been largely solved within native web APIs.
Programming in native JavaScript is relatively painless today, compared to what
it was like five years ago.

Yet many web developers automatically start with jQuery by default, regardless
of the use case. Many developers know jQuery better than they know the native
[DOM API](https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model)
that is the standard implemented natively by browsers. Many front-end web
components are coded as jQuery plugins, which means that they require jQuery as
a dependency. It can actually be difficult to find very simple web components
(e.g. a progress bar, or date picker) that do not depend on jQuery.

### How deep is your foundation knowledge?

Use of a framework or library can be very desirable and useful - but in my
opinion you need to earn your way to being able to use it. You earn your way by
comprehensively understanding the underlying foundation technologies that the
library is built upon. And sometimes the best way to do this is to write the
library yourself.

Once you have a deep understanding of the foundation tools, that is when you
can unlock the true power of your creativity when it comes to building
software.

There is often a great deal of pressure to use existing components when
building software, especially within larger companies and other software widget
factories. This is often based on an overly simplistic view of total cost of
ownership of software, or a malevolent disregard for the financial welfare of
the customer paying for the software.

### Dependencies are not free

They require maintenance in their own right.

Interdependencies between different components need to be managed. Dependencies
are not always well maintained by the producers, and sometimes they lapse into
a state of not being maintained at all.

Dependencies can add massively to the total code footprint of your application,
depending on how large they are - which impacts on the amount of memory your
application needs to run.

Too many dependencies can impact negatively on the maintainability of software.
This comes back to simplicity and comprehensibility of the code base. If there
is an issue that traces back to the innards of some black-box library that was
included way-back when, it has the potential to be a nightmare to debug.

> "Programmers, not plumbers". Repeat it like a mantra.

### Throw away the implementation

Gradually we need to come around to the idea that "code is cheap".

> "What do you mean it's cheap, it doesn't seem cheap when I'm grinding it
> out?"

Code is cheap when you compare it to the cost of designing a solution to a
problem, and also compared to the cost of maintaining and modifying that
implementation down the track. Code should be treated as very transient in
nature, refactored often and well-tested.

Plus, if you're grinding it out, you're doing it wrong. The act of programming
should be as enjoyable / painful / emotional as any act of creation by any
artist. Good pain.
