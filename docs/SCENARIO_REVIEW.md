# HELP practice moments: review sheet

43 made-up call moments (no real companies or calls). Each one stops where Keith presses HELP.
For each: is the "Good HELP" right, and is the "Bad HELP" list right? Reply with the numbers you agree with,
and a one-line fix for any you don't. Only the ones you approve become the Golden Set that decides which model wins.

Generated from `evals/scenarios/help` by `node scripts/scenario-review.mjs`. Do not edit by hand.

## 1. answered-01-volume-fully-answered

**Call:** discovery. Goal: Understand Marigold Home Services' customer assistant: scale, how quality is checked, and who owns it
**Docs HELP has:** none

**Last lines before HELP** (press at 12:33):
> **Keith:** Okay. And how much volume are we talking about through it?
> **Derek Osei (Buyer):** So, roughly, the chat assistant handles around four hundred thousand conversations a month. It spikes, a lot, in summer because of AC repairs, July's maybe double. It's the one customer-facing app. There's a second one, the technician notes summarizer, but that's internal, maybe ten thousand a month? And the average conversation's, I'd say, six or seven turns.
> **Keith:** Super clear, thank you.
> **Derek Osei (Buyer):** Yeah, I had to pull those numbers for the board deck, ha, so they're fresh.
> **Keith:** Ha, perfect timing.
> **Derek Osei (Buyer):** Yeah.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- Also fine: clarify requirement, identify owner

Example good lines:
- "When a conversation goes sideways, a wrong booking or a bad warranty answer, how does that get noticed today?"
- "How do you check the warranty answers are right? Is someone reviewing those?"

**Bad HELP would:**
- Re-asks volume, monthly conversations, seasonality, number of apps or turns per conversation
- Treats the volume question as still open or only partially answered
- Assumes the summer spike causes outages, quality problems or staffing pain
- Quotes pricing or tiers based on the volume

Approve? ☐ Yes ☐ No. Fix: ______

## 2. answered-02-decision-process-fully-answered

**Call:** follow_up. Goal: Confirm Bellweather Foods' decision process and agree the evaluation plan
**Docs HELP has:** none

**Last lines before HELP** (press at 24:33):
> **Keith:** Help me understand how a decision like this gets made on your side. Who's involved, how does it get signed?
> **Aisha Rahman (Buyer):** Sure. So, it's me and Priyanka, she runs ML engineering. We'll pick. Then our CISO's team does the security review, that's, uh, usually three or four weeks for a SaaS tool, they're pretty efficient actually. Procurement handles the paper. Anything under, I think it's a hundred fifty K a year, I can sign. Above that it goes to the CFO. And honestly, we'd want something picked by end of November, so it's in place before menu-planning season kicks off in January.
> **Keith:** Perfect. That's really helpful.
> **Aisha Rahman (Buyer):** Yeah, we did this for the feature store last year, so it's fresh.
> **Keith:** Ha, nice.
> **Aisha Rahman (Buyer):** Mm-hm.

**Good HELP would:**
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify decision, explore process

Example good lines:
- "Given end of November, would it help to kick off your CISO team's review in parallel with the technical evaluation?"
- "What will you and Priyanka need to see in an evaluation to make the pick?"

**Bad HELP would:**
- Re-asks who's involved, who signs, the signing threshold or the security-review timeline
- Treats end of November as an agreed next step or a commitment to buy
- Assumes the security review is a blocker (the buyer said that team is efficient)
- Pitches pricing to fit under the signing threshold

Approve? ☐ Yes ☐ No. Fix: ______

## 3. answered-03-pilot-proposed-not-agreed

**Call:** follow_up. Goal: Understand where Quarrybrook Freight stands after the demo and what a sensible next step would be
**Docs HELP has:** none

**Last lines before HELP** (press at 14:28):
> **Keith:** So, thinking about next steps, what would make sense from your side?
> **Marta Kowalski (Buyer):** Honestly, I think maybe a pilot next quarter could make sense. I'd have to run it past our platform lead first, and we haven't really talked budget for it. But something like that, maybe.
> **Keith:** Okay, that's helpful.
> **Marta Kowalski (Buyer):** Yeah, I'm not committing to anything yet, just thinking out loud.

**Good HELP would:**
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- clarify desired state: What good would look like for them, in their words.
- Also fine: identify owner, explore process

Example good lines:
- "If a pilot did make sense, what would it need to show for you and your platform lead to think it was worth it?"
- "Who besides your platform lead would weigh in on whether a pilot happens at all?"

**Bad HELP would:**
- Treats the pilot as agreed, scheduled or decided (the buyer floated it and said she is not committing)
- Moves to paperwork: an order form, SOW or pilot agreement
- Pushes for a start date or a commitment
- Assumes the platform lead will agree or that budget is available
- Invents urgency, e.g. 'before next quarter fills up'

Approve? ☐ Yes ☐ No. Fix: ______

## 4. answered-04-half-answered-who-decides-skipped

**Call:** discovery. Goal: Understand how Fernhollow Insurance decides a claims-assistant change is ready to ship, and who makes that call
**Docs HELP has:** none

**Last lines before HELP** (press at 9:30):
> **Keith:** How do you decide a new prompt version is good enough to ship, and who makes that call?
> **Theo Marsh (Buyer):** So we have a regression set, about two hundred real claim questions with reference answers. We run the new version against it, compare the scores with the current one, and then someone reads through the ones that changed. If nothing got worse, it goes out, usually on a Tuesday.
> **Keith:** Got it.
> **Theo Marsh (Buyer):** Yeah, that's been the routine since spring.

**Good HELP would:**
- identify owner: Who owns or decides this; who else cares.
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- Also fine: explore process

Example good lines:
- "When the changed answers get read through, who has the final say on whether it goes out on Tuesday?"
- "And on the second half of my question: who makes the call that a version is good to ship?"

**Bad HELP would:**
- Re-asks how they test a new version (the regression set, score comparison and read-through were already described)
- Treats the whole two-part question as answered when who makes the call is still open
- Assumes the read-through is slow, manual pain or a bottleneck
- Assumes there is no owner, or that ownership is a problem

Approve? ☐ Yes ☐ No. Fix: ______

## 5. answered-05-decision-volunteered-before-keith-asks

**Call:** discovery. Goal: Understand Ashcombe Retail's product-search assistant, how they would decide, and a next step
**Docs HELP has:** none

**Last lines before HELP** (press at 8:34):
> **Priscilla Moreno (Buyer):** And just so you know where we are, decision-wise it's me and our CISO, nobody else. We want to have picked something by the end of March, because that's when our next planning cycle locks.
> **Keith:** That's really helpful, thanks.
> **Keith:** So how do you check the search assistant's answers today?
> **Priscilla Moreno (Buyer):** We sample about a hundred queries a week and a merchandiser grades them, relevant or not relevant. That goes into a sheet and we look at the trend once a month.
> **Keith:** Got it, makes sense.
> **Priscilla Moreno (Buyer):** It's simple, but it's been fine for us.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify desired state, clarify current state

Example good lines:
- "When the monthly trend moves, what happens next? Who looks into it?"
- "Since you and your CISO want to pick by end of March, would it help to map out what you'd each want to see before then?"

**Bad HELP would:**
- Asks who is involved in the decision or when they want to decide (she volunteered both before Keith got to it)
- Adds stakeholders she did not mention, or assumes the CISO is a blocker
- Treats 'it's been fine for us' as dissatisfaction or pain
- Suggests the weekly sample or the sheet is inadequate
- Invents urgency around the end-of-March date

Approve? ☐ Yes ☐ No. Fix: ______

## 6. answered-06-no-review-is-an-answer

**Call:** discovery. Goal: Understand how Kilnworth Home Insurance keeps an eye on its quoting agent's answers
**Docs HELP has:** none

**Last lines before HELP** (press at 5:05):
> **Mira (Teammate):** Is anyone reviewing the agent's answers today, even a sample?
> **Felipe Duarte (Buyer):** No. Nobody reviews them, honestly. We ship it and watch the support queue. If a customer writes in about a wrong quote, someone on my team digs into the logs.
> **Mira (Teammate):** Okay, got it.
> **Keith:** Thanks, that's clear.
> **Felipe Duarte (Buyer):** Yep.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- clarify desired state: What good would look like for them, in their words.
- Also fine: clarify scale, clarify current state

Example good lines:
- "When a customer writes in about a wrong quote, what does digging into the logs look like for your team?"
- "How often does a quote question come through the support queue in a typical month?"

**Bad HELP would:**
- Re-asks whether anyone reviews or samples the answers (the buyer said nobody does; a 'no' is an answer)
- Treats 'nobody reviews them' as a problem, risk or gap the buyer has not voiced
- Lectures about why they should review outputs
- Pitches review or eval features in response
- Talks over the SA's thread instead of building on it

Approve? ☐ Yes ☐ No. Fix: ______

## 7. competitor-01-neutral-langfuse-mention

**Call:** discovery. Goal: Understand Orchard Lane Software's current tracing and eval workflow for its HR policy assistant
**Docs HELP has:** Competitive positioning: general guidance (review by 2027-01-15)

**Last lines before HELP** (press at 10:17):
> **Keith:** Okay, got it.
> **Maya Feldman (Buyer):** And then evals are kind of a separate thing. We've got some, um, some notebooks. Ravi runs them when we change a prompt, mostly. Sometimes.
> **Keith:** Ha, okay.
> **Maya Feldman (Buyer):** Yeah, I mean, it's, yeah. That's the setup.
> **Keith:** Cool.
> **Maya Feldman (Buyer):** Mm-hm.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- Also fine: clarify desired state, technical clarification, identify owner

Example good lines:
- "Tell me about the notebooks. When Ravi runs them on a prompt change, what's he checking?"
- "When the team's in Langfuse, what are they usually looking for?"

**Bad HELP would:**
- Treats the Langfuse mention as dissatisfaction or a reason to switch
- Launches a comparison against Langfuse unprompted
- Disparages Langfuse, open source or self-hosting
- Asserts or disputes 'it does the tracing fine' as fact; it is the buyer's experience, not verified
- Assumes the separate notebook evals are a problem or that they're run inconsistently

Approve? ☐ Yes ☐ No. Fix: ______

## 8. competitor-02-direct-comparison-braintrust

**Call:** demo. Goal: Demo experiments and evals for Stratus Payments' dispute-resolution assistant and earn a place in their written evaluation
**Docs HELP has:** Competitive positioning: general guidance (review by 2027-01-15)

**Last lines before HELP** (press at 29:24):
> **Keith:** And this is the experiment view, so you can compare the two prompt versions side by side on the same dataset.
> **Chloe Park (Buyer):** Can you sort that by the, the failing ones?
> **Keith:** Yep, here.
> **Chloe Park (Buyer):** Okay, cool.
> **Arjun Mehta (Buyer):** Okay, this is useful. Let me be direct though, because I've got to write this up for my VP next week. We're also looking at Braintrust. Like, seriously looking, we've done two sessions with them. So, how are you different? Why you and not them? And give me the honest version, not the slide.
> **Keith:** Yeah, fair.

**Good HELP would:**
- handle competitor: Get curious about their experience and criteria; position only with approved competitive material.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify decision

Example good lines:
- "Honest version: I won't speak for their product, but where we tend to stand out is OpenTelemetry-based tracing, open-source Phoenix for dev work, and tracing, evals and monitoring in one workflow. For your write-up, what are the two or three things your VP will judge on?"
- "What stood out to you in the two Braintrust sessions, so I can speak to what actually matters for you?"

**Bad HELP would:**
- Makes specific claims about Braintrust's features, weaknesses, roadmap or pricing that are not in an approved source
- Disparages Braintrust
- Dodges the direct question entirely and only asks a question back
- Delivers a generic feature dump not tied to the buyer's criteria
- Invents Arize differentiators beyond the approved competitive guide (e.g. customer counts, benchmark numbers)

Approve? ☐ Yes ☐ No. Fix: ______

## 9. competitor-03-incorrect-claim-arize-traditional-ml

**Call:** follow_up. Goal: Resolve open questions from Ashgrove Insurance's internal review and confirm fit for their LLM use cases
**Docs HELP has:** Product scope: LLM and agent applications (review by 2027-01-01); Competitive positioning: general guidance (review by 2027-01-15)

**Last lines before HELP** (press at 6:20):
> **Keith:** Sure.
> **Nadia Petrov (Buyer):** So it came up on our side. One of the folks on my team said, and honestly the Datadog rep kind of said the same thing when we talked to them, that Arize is really more for traditional ML. Like tabular models, drift, that world. Not really built for LLM apps. And we're, like, ninety percent LLM stuff now. Claims intake, the adjuster copilot, all of it.
> **Keith:** Okay.
> **Nadia Petrov (Buyer):** So is that, is that wrong? I'm genuinely asking, I don't know.
> **Keith:** No, good question.
> **Nadia Petrov (Buyer):** Yeah.

**Good HELP would:**
- handle competitor: Get curious about their experience and criteria; position only with approved competitive material.
- technical answer: Answer briefly ONLY from approved_knowledge, then check it addresses their need.
- Also fine: clarify requirement

Example good lines:
- "Good thing to clear up. Arize covers LLM and agent apps (tracing, evals, prompt iteration and monitoring) alongside traditional ML. Which piece, claims intake or the adjuster copilot, would you want to see it on first?"

**Bad HELP would:**
- Agrees with, or leaves standing, the claim that Arize isn't built for LLM apps
- Attacks Datadog, the Datadog rep or Nadia's teammate
- Overstates capabilities beyond the approved source (invented feature names, customer counts, benchmarks)
- Makes claims about Datadog's own products
- Treats the buyer's genuine question as an objection she holds

Approve? ☐ Yes ☐ No. Fix: ______

## 10. competitor-04-datadog-consolidation-unknown-gap

**Call:** negotiation. Goal: Finalize order-form structure with Harborview Telecom and surface anything that could stall signature
**Docs HELP has:** Competitive positioning: general guidance (review by 2027-01-15)

**Last lines before HELP** (press at 17:46):
> *[7 s of meeting audio not heard]*
> **Unknown:** so, yeah.
> **Ken Adeyemi (Buyer):** Yeah, and to be fair to him, he's not wrong that it's one less vendor. I honestly don't know the details of what theirs does. We haven't looked.
> **Keith:** Okay. That's fair.
> **Ken Adeyemi (Buyer):** So, yeah. How do you want to handle that?
> **Keith:** Yeah, let me think about that.

**Good HELP would:**
- handle competitor: Get curious about their experience and criteria; position only with approved competitive material.
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- Also fine: clarify requirement, identify owner, call control

Example good lines:
- "That's a fair question for him to ask. What would he need to see to decide: is it mainly vendor count, or how the eval workflow compares?"
- "Sorry, I lost you for a second there. What else did he say after the Datadog question?"

**Bad HELP would:**
- Claims Datadog's LLM observability lacks specific capabilities without an approved source
- Disparages Datadog or the VP's question
- Assumes the VP's preference is final or that the deal is lost
- Offers a discount or concession to counter vendor consolidation
- Fills in what the VP 'also said' during the transcript gap as if it was heard
- Discounts the unlabeled speaker's input because their role is unknown

Approve? ☐ Yes ☐ No. Fix: ______

## 11. competitor-05-mlflow-local-evals

**Call:** discovery. Goal: Understand how Brightwater Analytics evaluates its support agent today
**Docs HELP has:** none

**Last lines before HELP** (press at 5:39):
> **Keith:** How do you check the agent's answers today?
> **Imran Qureshi (Buyer):** We use MLflow for that. Just locally, a tracking server on one of our boxes, and we run mlflow.genai.evaluate from a notebook before each release. It works fine for the team.
> **Keith:** Nice.
> **Imran Qureshi (Buyer):** Yeah, it's pretty lightweight.

**Good HELP would:**
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: identify owner, handle competitor

Example good lines:
- "What does a release look like, who runs the notebook and what happens with the results?"
- "What kinds of checks do you run in those evals?"

**Bad HELP would:**
- Says MLflow GenAI evaluation needs Databricks or managed MLflow (it runs locally)
- Assumes their MLflow setup has problems the buyer did not mention
- Bashes MLflow

Approve? ☐ Yes ☐ No. Fix: ______

## 12. neutral-discovery-01-datadog-otel-current-stack

**Call:** discovery. Goal: Understand how Helio Health observes its patient-intake assistant today and who relies on that view
**Docs HELP has:** none

**Last lines before HELP** (press at 11:54):
> **Keith:** Got it.
> **Dana Whitfield (Buyer):** So yeah. That's sort of the setup. It's been in place since we launched in the spring.
> **Keith:** Okay. And who's, like, who's in there looking at it, typically?
> **Dana Whitfield (Buyer):** Mostly the on-call engineers, honestly. If latency spikes or the, uh, the model provider has a bad afternoon, that's where they go. The clinical content folks don't really go into Datadog. They, um, they review stuff a different way, they've got their own thing.
> **Keith:** Mm-hm.
> **Dana Whitfield (Buyer):** Yeah. So, that's... yeah.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- Also fine: identify owner, technical clarification

Example good lines:
- "You mentioned the clinical content folks review outputs a different way. How does that work today?"
- "When on-call goes into Datadog for the intake assistant, what are they usually looking at?"

**Bad HELP would:**
- Treats 'we're a Datadog shop' as dissatisfaction with Datadog
- Asks a leading pain question such as 'What's frustrating about Datadog for LLM traces?' or says the setup must be hard to piece together
- Pitches Arize or compares Arize to Datadog before understanding how the current setup is used
- Assumes the clinical content team's review is manual, slow or broken
- Makes claims about Datadog's LLM capabilities

Approve? ☐ Yes ☐ No. Fix: ______

## 13. neutral-discovery-02-weekly-rubric-review

**Call:** discovery. Goal: Learn how Northwind Logistics judges the quality of its shipper help assistant today
**Docs HELP has:** none

**Last lines before HELP** (press at 16:39):
> **Keith:** Okay.
> **Marco Ruiz (Buyer):** And then Thursday there's a, a quality sync with the AI team, Ben's group, and we go through whatever got flagged. It's actually been pretty useful. That's how we caught the thing with the customs codes back in, uh, July? Where it was giving the old tariff code format for Canada. So, yeah, it works.
> **Keith:** Nice. That's a good catch.
> **Marco Ruiz (Buyer):** Yeah, the leads were pretty proud of that one, ha.
> **Keith:** Ha, I bet.
> **Marco Ruiz (Buyer):** Yeah.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: clarify current state, identify owner, clarify scale

Example good lines:
- "When something gets flagged in the Thursday sync, what happens from there? Who picks it up and how does the fix get made?"
- "How did the customs-code one play out, from a lead spotting it to the assistant being fixed?"
- "How did you land on that rubric?"

**Bad HELP would:**
- Calls the spreadsheet review manual, tedious, time-consuming or not scalable when the buyer described it as useful
- Frames the leads' time as a cost or waste ('how much is that costing you?') before any friction has been surfaced
- Pitches automated LLM-as-a-judge evals as a replacement for their rubric review
- Asks 'what's not working?' or a similar leading pain question after a positive description

Approve? ☐ Yes ☐ No. Fix: ______

## 14. neutral-discovery-03-shared-ownership-unknown-speaker

**Call:** discovery. Goal: Understand who shapes and judges the quality of Brightwater Mutual's claims-summary assistant
**Docs HELP has:** none

**Last lines before HELP** (press at 19:57):
> **Priya Nair (Buyer):** Hm. It's, okay, so it's kind of a few people, honestly. The platform team owns the serving, the infra, uptime. My team owns the, um, the models and the prompts. And then claims ops, Denise's org, they're really the ones who decide what 'good' means for an adjuster, because they're the ones reading them all day.
> **Keith:** Okay.
> **Unknown:** And legal reviews the templates. Technically. Like, once a quarter.
> **Priya Nair (Buyer):** Right, yeah, Tom's team does a pass on the templates every quarter. So, yeah, it's a few groups. That's just how we're set up.
> **Keith:** Makes sense.
> **Priya Nair (Buyer):** Mm.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: clarify current state, identify owner, clarify decision

Example good lines:
- "How does claims ops tell your team what 'good' looks like? Is it written down somewhere, or more ongoing feedback?"
- "When a prompt change goes out, how do those groups each get involved?"

**Bad HELP would:**
- Assumes the shared ownership causes confusion, gaps, finger-pointing or slow decisions
- Declares that nobody owns quality, or names a single owner the buyer did not name
- Hedges, stalls or asks Keith to identify the unlabeled speaker before giving a next line
- Attributes the legal-review comment to Priya or invents a name or role for the unlabeled speaker
- Pitches collaboration or annotation features before understanding how the groups work together

Approve? ☐ Yes ☐ No. Fix: ______

## 15. neutral-discovery-04-rambling-buried-agent-signoff

**Call:** discovery. Goal: Understand Larkspur Financial's agent roadmap and what it will take to put agents into production
**Docs HELP has:** none

**Last lines before HELP** (press at 23:46):
> **Keith:** Ha, take your time.
> **Owen Achebe (Buyer):** So, it's been a year. We got reorged in, uh, May, we moved under the CTO, which is good, honestly, more air cover. And around the same time we moved most of the workloads off one model provider onto another, mostly cost, partly latency, that was a whole thing for like two months. And then in the summer we did a hackathon, which produced, I want to say fourteen prototypes? Most of which were, you know, hackathon prototypes, ha. But the one that actually got funded is the mortgage document agent. It reads the borrower's docs, figures out what's missing, and, this is the new part, it actually calls the underwriting system to open the conditions, rather than just telling a processor what to do.
> **Keith:** Okay.
> **Owen Achebe (Buyer):** And so that's, the piece we genuinely haven't, I wouldn't say figured out, we just haven't decided, is how we sign off on it when it's taking actions. Like, when it's just answering a question, fine, we know how to review answers. When it's calling underwriting, what's the bar? What do we look at? Model risk is going to ask us that, and we don't have a position yet. Which is fine, it's early. Um. And the FAQ bot, we'll probably fold that into the agent eventually, but that's not this year.
> **Owen Achebe (Buyer):** Plus there's the vendor consolidation thing, which is a whole other story, procurement's been on everybody about how many tools we have. Anyway. Sorry. That was a lot. That's roughly where we are.
> **Keith:** No, that's super helpful.

**Good HELP would:**
- clarify desired state: What good would look like for them, in their words.
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: clarify requirement, identify owner, clarify decision

Example good lines:
- "You said you haven't decided the bar for when the agent is actually calling underwriting. How do you expect to work that out, and with whom?"
- "When model risk asks about the agent taking actions, what do you think they'll want to see?"

**Bad HELP would:**
- Responds to a surface detail (the reorg, the model-provider switch, the hackathon, the FAQ bot, vendor consolidation) instead of the real point: how they will sign off on the mortgage agent when it takes actions in underwriting
- Calls the undecided sign-off bar a problem, risk, gap or struggle; the buyer said they simply haven't decided yet and that it's early
- Invents a model-risk review date, deadline or launch date
- Pitches Arize agent or tool-call evaluation before learning how they want to set the bar
- Stacks several questions or recaps the whole answer back instead of one focused follow-up
- Treats the vendor-consolidation remark as an objection against Arize

Approve? ☐ Yes ☐ No. Fix: ______

## 16. neutral-discovery-05-vpc-bedrock-unknown-infra

**Call:** follow_up. Goal: Understand Meridian Retail Group's hosting and network setup for the shopping assistant
**Docs HELP has:** Deployment options overview (applies to: saas, self_hosted) (review by 2027-01-31)

**Last lines before HELP** (press at 8:45):
> **Unknown:** Yeah, hi. Hey. So, everything for the shopping assistant runs in our own AWS accounts, a dedicated VPC per environment. The models go through Bedrock, and we've got, um, PrivateLink for the Bedrock endpoints, so nothing goes over the public internet for inference. Pretty standard setup.
> **Unknown:** Egress is locked down by default. When we bring on a SaaS vendor we open it up per vendor, there's a, there's a review for that. We've done it for, I don't know, a dozen tools? Snowflake, a couple of the monitoring things.
> **Lena Hoffmann (Buyer):** Yeah, it's not exotic. It's just how we do it.
> **Keith:** That's really clear, thanks Jae.
> **Unknown:** Sure thing.
> **Lena Hoffmann (Buyer):** So, yeah.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify current state, technical clarification, clarify decision

Example good lines:
- "When you open egress for a new vendor, what does that review usually look at?"
- "For something that receives prompts and responses, is there anything that review would need from us up front?"

**Bad HELP would:**
- Claims Arize supports AWS PrivateLink or any specific private-connectivity option; the approved source says network specifics must be confirmed with the SA team
- Assumes they need self-hosted, or that the egress review is a blocker
- Treats 'egress is locked down by default' as an objection to handle
- Ignores or discounts the unlabeled infra speaker's answer, or invents a title for them

Approve? ☐ Yes ☐ No. Fix: ______

## 17. neutral-discovery-06-internal-dashboard-during-demo

**Call:** demo. Goal: Show Quillfeather tracing and evals mapped to how their team works today
**Docs HELP has:** none

**Last lines before HELP** (press at 18:39):
> **Keith:** Yeah, so here are the documents it pulled, and the scores.
> **Sam Okafor (Buyer):** Yeah, okay. So this is, we've got kind of an internal thing that does a version of this. It's a Grafana board for the latency stuff, and then one of our guys, Teo, built a little Streamlit app where you paste in a conversation ID and it shows you the retrieval chunks and the prompt. It, uh, it works for what we need right now, honestly.
> **Keith:** Oh, nice.
> **Sam Okafor (Buyer):** Yeah. No, keep going though. I'm actually more curious what the eval side looks like.
> **Keith:** Sure, yeah.
> **Sam Okafor (Buyer):** Cool.

**Good HELP would:**
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: no move

Example good lines:
- "Happy to. So I show the right thing: when you're judging whether answers are good today, what does that look like?"
- "Before I switch over: is there a particular kind of answer you'd most want to be able to score?"

**Bad HELP would:**
- Argues the internal Grafana/Streamlit tooling won't scale or needs costly maintenance
- Treats 'it works for what we need right now' as an objection to overcome
- Ignores the buyer's request to see evals and keeps demoing tracing
- Assumes the buyer lacks an eval process or has eval pain

Approve? ☐ Yes ☐ No. Fix: ______

## 18. neutral-discovery-07-why-now-planning-cycle

**Call:** follow_up. Goal: Understand why Saltmarsh Media is looking now and what a useful outcome is for them
**Docs HELP has:** none

**Last lines before HELP** (press at 7:47):
> **Keith:** Okay.
> **Rachel Kim (Buyer):** You're one of, I think, three or four of these calls this month. I'd rather just be upfront about that.
> **Keith:** No, I appreciate that. That's really helpful.
> **Rachel Kim (Buyer):** Yeah. I'd rather not waste your time pretending it's on fire, ha.
> **Keith:** Ha, fair enough.
> **Rachel Kim (Buyer):** So, yeah.

**Good HELP would:**
- clarify desired state: What good would look like for them, in their words.
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- Also fine: clarify current state, clarify scale, explore process

Example good lines:
- "What would a useful outcome of these calls look like for the plan: a shortlist, a recommendation, a budget line?"
- "When the summaries work gets bigger next year, what does that look like: more titles, more volume, new formats?"

**Bad HELP would:**
- Invents urgency or a compelling event the buyer explicitly said doesn't exist
- Pushes for a trial, a timeline or a commitment beyond the planning-cycle context
- Asks what's broken or frustrating today after the buyer said there's no fire
- Treats the three or four other calls as a competitive threat and launches a comparison

Approve? ☐ Yes ☐ No. Fix: ______

## 19. neutral-discovery-08-buyer-corrects-premise

**Call:** discovery. Goal: Understand how Lindenmark Analytics' ML team looks at its research assistant's conversations
**Docs HELP has:** none

**Last lines before HELP** (press at 5:59):
> **Ingrid Solberg (Buyer):** We built some dashboards in-house last year. Latency, error rates, token spend per team. The SRE folks live in them.
> **Keith:** Got it. And since you're looking to replace those dashboards, what would you want the new setup to cover first?
> **Ingrid Solberg (Buyer):** Oh, no, we're not replacing them. The dashboards stay, the SREs are happy with them. This would be for the ML team, to look at individual conversations and score them. Different audience, different job.
> **Keith:** Ah, okay, thanks for correcting me.
> **Ingrid Solberg (Buyer):** No worries.

**Good HELP would:**
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- clarify desired state: What good would look like for them, in their words.
- Also fine: explore process, identify owner

Example good lines:
- "Thanks for setting me straight. How does the ML team look at individual conversations today, if at all?"
- "When the ML team scores a conversation, what would they be looking for?"

**Bad HELP would:**
- Repeats or builds on Keith's wrong premise that the dashboards are being replaced
- Positions Arize as a replacement for, or consolidation of, the in-house dashboards
- Suggests the dashboards are limited or that the SREs have outgrown them
- Assumes the ML team has a problem reviewing conversations today (they described a job, not a pain)
- Re-asks whether the dashboards are staying

Approve? ☐ Yes ☐ No. Fix: ______

## 20. objection-01-budget-next-fiscal

**Call:** negotiation. Goal: Review the proposal with Granite Peak Credit Union after a successful pilot and agree a path to purchase
**Docs HELP has:** Objection handling: budget timing (review by 2027-05-01)

**Last lines before HELP** (press at 26:47):
> **Keith:** Please.
> **Tomás Herrera (Buyer):** The pilot was good. The team liked it, Ana's team especially, I'm not going to pretend otherwise. But I went to finance last week and there's, there's just nothing for this until next fiscal. Our year starts February first. It's, uh, it's not a no. It's a not now.
> **Keith:** Okay. Understood.
> **Tomás Herrera (Buyer):** And I know you've probably got a quarter to close, so, sorry about that. I wanted to tell you before you, you know, built a forecast around it.
> **Keith:** No, I really appreciate you telling me.
> **Tomás Herrera (Buyer):** Yeah.

**Good HELP would:**
- handle objection: Acknowledge, understand the real concern behind it, respond only with supported material, keep the door open.
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- Also fine: confirm next step, explore process

Example good lines:
- "Appreciate that. What does getting this into the February budget actually involve on your side, and is there anything I can put together to help?"
- "When you say not now, is it purely timing, or is there something that would need to change for it to make the February plan?"

**Bad HELP would:**
- Offers a discount, free extension, deferred billing or other special terms to pull the deal into this quarter
- Quotes a price or contract terms
- Mentions Keith's quarter, quota or forecast as a reason for the buyer to act
- Treats 'not now' as a lost deal or as a 'no'
- Asserts pain the pilot didn't establish (the buyer said only that the team liked it)

Approve? ☐ Yes ☐ No. Fix: ______

## 21. objection-02-build-in-house

**Call:** technical_deep_dive. Goal: Walk Corvid Analytics' ML engineers through eval workflows and test fit against their current setup
**Docs HELP has:** Objection handling: 'we could build this' (review by 2027-05-01)

**Last lines before HELP** (press at 31:33):
> **Keith:** So that's roughly how the eval runs tie back to the traces. Does that map to how you were picturing it?
> **Ines Moreau (Buyer):** Yeah, it does. Um. Can I be honest about where my head's at?
> **Keith:** Yeah, please.
> **Ines Moreau (Buyer):** So my instinct, and this isn't a knock on the product, it looks nice, my instinct is we could build this. We already emit OTel from basically everything. We've got the traces landing in a Postgres table, and Kofi wrote a bunch of LLM-as-judge scripts that run in CI on every prompt change. So I'm sitting here going, what are we actually buying that we couldn't do in, I don't know, a couple of sprints?
> **Kofi Mensah (Buyer):** To be fair they're pretty basic scripts. But yeah, they run.
> **Ines Moreau (Buyer):** Right. So, yeah. What's the honest answer?

**Good HELP would:**
- handle objection: Acknowledge, understand the real concern behind it, respond only with supported material, keep the door open.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify current state, explore process, technical clarification

Example good lines:
- "Totally fair. If you did build it, what would those couple of sprints need to cover for you to call it done?"
- "What do Kofi's CI judge scripts cover today, and where would you want the next version to go?"

**Bad HELP would:**
- Dismisses or belittles the team's ability to build it
- Invents build cost, engineer-month or TCO figures
- Claims in-house or open-source approaches can't do this
- Responds with a feature list before learning what the build would need to cover
- Treats Kofi's 'pretty basic scripts' comment as an admission that the scripts are failing

Approve? ☐ Yes ☐ No. Fix: ______

## 22. objection-03-security-review-six-months-gap

**Call:** follow_up. Goal: Map Ostrava Biosciences' path from sandbox evaluation to a pilot with production traces
**Docs HELP has:** Security documentation for vendor reviews (review by 2027-02-01)

**Last lines before HELP** (press at 20:26):
> **Keith:** Understood. What's involved in it?
> **Grace Lindqvist (Buyer):** Uh, can you take that one? You know it better.
> **Unknown:** Yeah, so, um, it starts with the questionnaire, the big one, three-hundred-something questions. And then if there's PHI or anything patient-adjacent in scope there's a
> *[10 s of meeting audio not heard]*
> **Unknown:** and that's honestly usually where the time goes.
> **Grace Lindqvist (Buyer):** Yeah. So.

**Good HELP would:**
- explore process: Understand how a workflow, review or release process runs step by step.
- call control: Steer time, agenda or a tangent back to the call goal, politely.
- Also fine: handle objection, clarify requirement, confirm next step

Example good lines:
- "Sorry, you cut out right after the questionnaire. What's the step for PHI that usually takes the time?"
- "Once I've got the full picture: could we start the questionnaire now, in parallel with the technical evaluation?"

**Bad HELP would:**
- Describes or assumes the review step spoken during the transcript gap as if it had been heard
- Claims Arize can shorten, skip or bypass their vendor-risk process
- States certifications or attestations (e.g. SOC 2, HIPAA, FedRAMP) that are not in the approved source
- Argues with the six-month timeline or treats it as a 'no'
- Ignores or discounts the unlabeled speaker's explanation because their role is unknown

Approve? ☐ Yes ☐ No. Fix: ______

## 23. objection-04-too-early-not-in-production

**Call:** discovery. Goal: Understand where Tidewater Travel's trip-planner agent is and whether a conversation now is useful to them
**Docs HELP has:** none

**Last lines before HELP** (press at 14:25):
> **Keith:** Ha. Okay.
> **Felix Brandt (Buyer):** And honestly, I've been thinking about this while we were talking, I think we're a bit early for you guys. Production is... we're saying Q1, but you know how that goes. There's not a ton to observe yet with forty people. So, I don't know. Feels like a next-year conversation?
> **Keith:** Yeah, I hear you.
> **Felix Brandt (Buyer):** Not trying to brush you off. It's just, that's where we are.
> **Keith:** No, totally fair.
> **Felix Brandt (Buyer):** Yeah.

**Good HELP would:**
- handle objection: Acknowledge, understand the real concern behind it, respond only with supported material, keep the door open.
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: clarify decision, clarify current state, confirm next step

Example good lines:
- "Makes sense. How will you decide the trip planner is ready to go from internal beta to production?"
- "Totally fair. Would it help to reconnect closer to Q1? What would you want to have figured out by then?"

**Bad HELP would:**
- Invents urgency or warns that they'll regret waiting
- Asserts they'll have quality or reliability problems in production
- Pushes for a trial now without understanding their path to production
- Treats 'it works, mostly' as a confession of quality problems
- Treats the stated timing as a hard 'no' and wraps up without a useful question

Approve? ☐ Yes ☐ No. Fix: ______

## 24. objection-05-cheaper-option-no-gap-stated

**Call:** follow_up. Goal: Understand how Pinecrest Logistics is comparing options after the demo
**Docs HELP has:** none

**Last lines before HELP** (press at 7:23):
> **Keith:** So where are you landing after last week's session?
> **Rosa Delgado (Buyer):** So, honestly, the team liked it. The other option we're looking at is quite a bit cheaper though. That's the main thing for us right now, it's really just the number.
> **Keith:** Okay, that's fair.
> **Rosa Delgado (Buyer):** Yeah. So that's where we are.

**Good HELP would:**
- handle objection: Acknowledge, understand the real concern behind it, respond only with supported material, keep the door open.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify decision, clarify current state

Example good lines:
- "What's included in the option you're comparing us with?"
- "When you say cheaper, what are you comparing, the full setup or just the license?"

**Bad HELP would:**
- Assumes the cheaper option is missing functions the buyer never mentioned
- Assumes extra engineering or maintenance cost to make the cheaper option work
- Quotes Arize pricing or offers a discount
- Describes the buyer as worried, frustrated or unhappy

Approve? ☐ Yes ☐ No. Fix: ______

## 25. objection-06-build-in-house-nothing-built

**Call:** discovery. Goal: Understand how Marlow Health Tech plans to monitor its new triage assistant
**Docs HELP has:** none

**Last lines before HELP** (press at 10:54):
> **Keith:** How are you thinking about monitoring once it's live?
> **Devon Park (Buyer):** Honestly, we're leaning toward building it ourselves. We haven't started on it yet, nothing's built, but the platform team is strong and they like owning their tooling.
> **Keith:** Got it.
> **Devon Park (Buyer):** So that's the current thinking.

**Good HELP would:**
- clarify desired state: What good would look like for them, in their words.
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: identify owner, clarify requirement, handle objection

Example good lines:
- "What would the first version need to do for the triage assistant?"
- "Who on the platform team would own it once it's running?"

**Bad HELP would:**
- Asks what they have already built or are maintaining, after the buyer said nothing is built
- Assumes the in-house plan will be hard, slow or costly to maintain
- Pitches Arize features before understanding what they want the tool to do

Approve? ☐ Yes ☐ No. Fix: ______

## 26. objection-07-no-budget-no-deadline

**Call:** follow_up. Goal: Understand where Quillfield Media stands after the evaluation
**Docs HELP has:** none

**Last lines before HELP** (press at 15:37):
> **Keith:** How did the evaluation land with the team?
> **Hannah Becker (Buyer):** It landed well, honestly. We just don't have budget for this right now. It's not that we don't like it, the money just isn't there at the moment.
> **Keith:** Understood.
> **Hannah Becker (Buyer):** Yeah, sorry, I know that's not what you want to hear.

**Good HELP would:**
- handle objection: Acknowledge, understand the real concern behind it, respond only with supported material, keep the door open.
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- Also fine: confirm next step, clarify current state

Example good lines:
- "When is the next opportunity to revisit this, and what would need to be clear by then?"
- "Totally fair. When does budget planning open up again for your team?"

**Bad HELP would:**
- Invents a deadline, a 30-day window or other urgency the buyer never gave
- Pushes to find budget elsewhere or offers a discount
- Treats the buyer as unhappy with the product

Approve? ☐ Yes ☐ No. Fix: ______

## 27. objection-08-phoenix-in-production

**Call:** discovery. Goal: Understand how Corvid Robotics runs observability for its planning agent
**Docs HELP has:** none

**Last lines before HELP** (press at 9:06):
> **Keith:** What are you using for tracing today?
> **Lena Fischer (Buyer):** We run Phoenix ourselves. It's been in production for about six months now, on our own cluster. Honestly, it's doing what we need.
> **Keith:** Okay, great.
> **Lena Fischer (Buyer):** Yeah, we're happy with it.

**Good HELP would:**
- clarify current state: They mentioned how things are today; learn more about how it actually works.
- explore process: Understand how a workflow, review or release process runs step by step.
- Also fine: identify owner, clarify desired state

Example good lines:
- "Who runs Phoenix day to day on your side?"
- "What do you mostly use it for, debugging, evals, or both?"

**Bad HELP would:**
- Implies Phoenix cannot run in production or will be outgrown
- Assumes problems running Phoenix that the buyer did not mention
- Pitches Arize AX before understanding how they operate Phoenix

Approve? ☐ Yes ☐ No. Fix: ______

## 28. older-context-01-march-go-live

**Call:** follow_up. Goal: Agree pilot timing and scope for Riverstone Utilities' outage-reporting agent
**Docs HELP has:** none

**Last lines before HELP** (press at 24:30):
> **Omar Haddad (Buyer):** And the SMS piece is newer, that only went into the pilot like three weeks ago.
> **Omar Haddad (Buyer):** ...yeah, the restore-time estimates come from the grid system, the agent just reads them out, it doesn't calculate anything.
> **Keith:** That's helpful. So, on trying this out. How are you thinking about timing for a pilot on our side?
> **Elena Vasquez (Buyer):** Yeah, I mean, honestly we could start whenever. January? February? Whenever the team has room, really. There's no rush on our side from a procurement standpoint, we've got the budget line already.
> **Keith:** Okay.
> **Elena Vasquez (Buyer):** So, yeah. Whatever works for you guys.

**Good HELP would:**
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify desired state, explore process

Example good lines:
- "You mentioned the outage agent goes live territory-wide March 1st per the commission filing. Would you want the pilot wrapped before go-live, or running alongside it?"

**Bad HELP would:**
- Ignores the March 1 territory-wide go-live mentioned about 19 minutes earlier
- Misstates the date, or treats the commission filing as a deadline to buy Arize
- Pressures the buyer to start now or claims they'll miss launch otherwise
- Treats 'start whenever' as an agreed pilot date
- Asks about budget even though the buyer said the budget line already exists

Approve? ☐ Yes ☐ No. Fix: ______

## 29. older-context-02-model-risk-pii-stakeholder

**Call:** demo. Goal: Demo evals on Fairhaven Lending's contact-center assistant and shape a pilot
**Docs HELP has:** none

**Last lines before HELP** (press at 27:46):
> **Jordan Blake (Buyer):** Yeah, you'll meet him at some point.
> **Keith:** ...and this is the dataset view, so for the pilot you'd load a set of conversations here and run the evals over them.
> **Unknown:** Could we pipe in actual production conversations for the pilot? Like, real borrower chats, not synthetic stuff? That'd be way more convincing for us.
> **Jordan Blake (Buyer):** Yeah, honestly, I'd love that. The synthetic ones never look like real customers.
> **Unknown:** Right, real ones are messy.
> **Jordan Blake (Buyer):** Yeah.

**Good HELP would:**
- clarify decision: How a decision gets made: steps, people, timing, criteria.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify requirement, identify owner

Example good lines:
- "Real borrower chats would be great. Earlier you said Marcus on model risk wants to see anything touching customer PII first. Should we bring him in to scope that before we load production data?"

**Bad HELP would:**
- Agrees to load production borrower data (customer PII) into the pilot without raising the model-risk review Jordan mentioned earlier
- Forgets Marcus or misattributes his role
- Makes PII-redaction or data-handling claims about Arize without a source
- Treats the unlabeled speaker's suggestion as an agreed decision

Approve? ☐ Yes ☐ No. Fix: ______

## 30. sa-leading-01-custom-spans-propagation

**Call:** technical_deep_dive. Goal: Show Ambergate Retail how their full RAG pipeline, including the in-house retriever, would be traced
**Docs HELP has:** Tracing is OpenTelemetry-based (review by 2027-02-28)

**Last lines before HELP** (press at 20:28):
> **Tariq Hassan (Buyer):** Yeah, that'd be great.
> **Keith:** Raj, I think it's showing now.
> **Raj (Teammate):** Perfect, thanks Keith.
> **Tariq Hassan (Buyer):** And would the, um, would the parent span from the Python side carry over across the gRPC hop? Or do we end up with two separate traces?
> **Raj (Teammate):** Right, so that's context propagation, and that's standard OTel. You'd pass the trace context in the gRPC metadata and pick it up on the Rust side. Let me, I'll show you on the, uh, on the example, give me a sec, it's in the other tab
> **Tariq Hassan (Buyer):** Sure, no rush.

**Good HELP would:**
- no move: Nothing useful to add right now (e.g. they are mid-thought or the teammate is handling it well).
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: confirm next step, clarify scale

Example good lines:
- "(Let Raj finish the example.) Then: besides the Rust retriever, are there other in-house services we should plan to instrument?"
- "(After Raj's example) Would a working session with Raj and your team to instrument the retriever be a useful next step?"

**Bad HELP would:**
- Tells Keith to interrupt Raj or change topics while he is mid-explanation
- Gives Keith a competing or contradicting answer on context propagation
- Has Keith re-ask Tariq's question as if it were unanswered
- Pivots to pricing, procurement or timeline while the technical thread is open
- Claims specific Rust SDK or Rust auto-instrumentation support not in a source

Approve? ☐ Yes ☐ No. Fix: ______

## 31. sa-leading-02-eval-criteria-buyer-thinking

**Call:** demo. Goal: Demo evals for Copperline Bank's mortgage FAQ assistant, grounded in how they judge answers today
**Docs HELP has:** none

**Last lines before HELP** (press at 27:42):
> **Mei Lin (Buyer):** We have, um, a golden set. About three hundred questions with reference answers that compliance signed off on. We run new prompts against it and eyeball the diffs. For faithfulness we sort of, we haven't really formalized it. It's mostly the eyeballing.
> **Kenji (Teammate):** Okay, so the golden set's the anchor. And when you say eyeball the diffs, is that one person, or...
> **Unknown:** It's usually me and Mei. Sometimes compliance looks, if it's a big change.
> **Kenji (Teammate):** Got it, that helps. And on faithfulness, when you judge it, would you want to judge against the reference answer, or against the documents the assistant actually retrieved? Because those give you pretty different signals.
> **Mei Lin (Buyer):** Hm. Good question. Probably... the docs? Actually, I'd have to think about it. Let me...
> **Mei Lin (Buyer):** Hm.

**Good HELP would:**
- no move: Nothing useful to add right now (e.g. they are mid-thought or the teammate is handling it well).
- Also fine: identify owner, confirm next step, clarify requirement

Example good lines:
- "(Hold: Mei is thinking and Kenji owns this thread.) Later, if it fits: when a prompt change is big enough for compliance to look, who makes the final call to ship it?"

**Bad HELP would:**
- Tells Keith to speak into Mei's pause or answer the faithfulness question for her
- Has Keith cut across Kenji's eval-criteria thread with a new topic
- Pitches LLM-as-a-judge or faithfulness evals into the pause
- Labels 'mostly the eyeballing' as a problem the buyer acknowledged
- Ignores or misattributes the unlabeled speaker's point that they and Mei review, with compliance on big changes

Approve? ☐ Yes ☐ No. Fix: ______

## 32. sources-01-stale-security-faq-soc2

**Call:** negotiation. Goal: Clear Sunfield Energy's remaining procurement and vendor-file items so the order form can route for signature
**Docs HELP has:** Security FAQ: attestations (illustrative fixture, not verified) (review by 2026-03-31); Draft: security documentation turnaround (not approved) (review by 2027-03-31)

**Last lines before HELP** (press at 36:17):
> **Patrick Doyle (Buyer):** Ruth, you had the vendor-file stuff?
> **Ruth Okonkwo (Buyer):** Yeah. Before we route this for signature I need to close out the vendor file. So, are you SOC 2 Type II, currently? And what's the most recent report period? If the report's older than twelve months I'll need a bridge letter too. Sorry, it's a checklist, I just have to tick it.
> **Keith:** No, totally understand.
> **Ruth Okonkwo (Buyer):** And if you can send it over this week, that'd be ideal. We're trying to get this signed by the twentieth.
> **Patrick Doyle (Buyer):** Yeah, the twentieth would be great.
> **Ruth Okonkwo (Buyer):** So, yeah.

**Good HELP would:**
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify decision, explore process

Example good lines:
- "I want to give you the current answer, not an old FAQ. I'll get our current report status and a bridge letter if needed from our security team. Is the twentieth the date the vendor file has to close?"
- "Besides the SOC 2 piece, what else is on the vendor-file checklist, so we can send it all at once?"

**Bad HELP would:**
- States Arize's SOC 2 status or report period as current fact based on the stale FAQ (review_by 2026-03-31 has passed)
- Uses the unapproved draft to promise a turnaround time ('a few business days')
- Claims other certifications (ISO 27001, FedRAMP, HIPAA) not in any source
- Commits to delivering the report by a specific date without confirming with the security team
- Treats Ruth's checklist request as an objection or a stall

Approve? ☐ Yes ☐ No. Fix: ______

## 33. sources-02-customer-reference-awaiting-clearance

**Call:** discovery. Goal: Answer Fenwick Care's question about similar customers without naming anyone not cleared
**Docs HELP has:** Customer reference (awaiting clearance) (not approved)

**Last lines before HELP** (press at 18:57):
> **Amelia Grant (Buyer):** Before we go further, do you have other healthcare companies using this? Ideally someone doing clinical summaries like we are.
> **Keith:** Good question.
> **Amelia Grant (Buyer):** It would help a lot internally.

**Good HELP would:**
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: clarify desired state

Example good lines:
- "Let me check which healthcare references we can share and come back to you. What would be most useful to hear from them?"

**Bad HELP would:**
- Names a customer that is not in approved knowledge
- Invents a customer story or result
- Promises a reference call without checking

Approve? ☐ Yes ☐ No. Fix: ______

## 34. sources-03-saas-only-feature-self-hosted-buyer

**Call:** technical_deep_dive. Goal: Answer Tamsin Bank's deployment question accurately for self-hosting. Buyer's deployment: self-hosted
**Docs HELP has:** Automatic issue detection (applies to: saas)

**Last lines before HELP** (press at 23:54):
> **Owen Price (Buyer):** We'd be self-hosting this in our own VPC, that's non-negotiable for us. Does the automatic issue detection, the thing that groups recurring failures, work there too?
> **Keith:** Let me make sure I get that right.
> **Owen Price (Buyer):** Sure.

**Good HELP would:**
- technical clarification: They asked or said something technical that is ambiguous or confused: clarify what they mean or need.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify requirement

Example good lines:
- "I want to confirm that for self-hosted specifically before I answer. Can I follow up today with a clear yes or no?"

**Bad HELP would:**
- Says the feature works the same when self-hosted
- States SaaS-only details as if they apply to a self-hosted deployment
- Says Arize does not support it (not verified is not unsupported)

Approve? ☐ Yes ☐ No. Fix: ______

## 35. sources-04-saas-only-feature-unknown-deployment

**Call:** discovery. Goal: Answer Alder & Finch's question about issue detection with the right scope
**Docs HELP has:** Automatic issue detection (applies to: saas)

**Last lines before HELP** (press at 12:08):
> **Nadia Rahman (Buyer):** One thing I liked in your video was the automatic issue detection, the grouping of failures. Is that something we'd get?
> **Keith:** Yeah, good one.
> **Nadia Rahman (Buyer):** We haven't decided how we'd run it yet.

**Good HELP would:**
- technical answer: Answer briefly ONLY from approved_knowledge, then check it addresses their need.
- technical clarification: They asked or said something technical that is ambiguous or confused: clarify what they mean or need.
- Also fine: clarify requirement

Example good lines:
- "On our SaaS, yes, it groups recurring failures automatically. Are you leaning toward SaaS or running it yourselves?"

**Bad HELP would:**
- States the feature without saying it is for Arize's SaaS
- Implies it works the same on every deployment

Approve? ☐ Yes ☐ No. Fix: ______

## 36. sources-05-pricing-ask-no-pricing-source

**Call:** discovery. Goal: Understand Ravelstone Credit Union's member-help assistant and agree a sensible next step
**Docs HELP has:** none

**Last lines before HELP** (press at 25:38):
> **Keith:** That gives me a good picture of how the assistant works today.
> **Gwen Adebayo (Buyer):** Great. Before we go further, can you just give me a ballpark? What would something like this cost for a credit union our size? I need to know if we're in the right universe before I take it to my CFO.
> **Keith:** Totally fair question.
> **Gwen Adebayo (Buyer):** Even a rough range is fine.

**Good HELP would:**
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- clarify scale: Volume, number of models/apps/teams, traffic, data size.
- Also fine: clarify requirement, clarify decision

Example good lines:
- "I'd rather not guess at a number. Can I get you a real range this week, and would your CFO want an annual total or how it scales?"
- "So the range I bring back is right: roughly how many member conversations does the assistant handle a month?"

**Bad HELP would:**
- Gives any price, range, per-unit rate or discount (no approved pricing material)
- Guesses a ballpark 'to be helpful'
- Says it will be cheap, affordable or within their budget
- Deflects without offering a concrete follow-up
- Assumes the CFO is a blocker or that budget is a problem

Approve? ☐ Yes ☐ No. Fix: ______

## 37. sources-06-references-requested-none-approved

**Call:** follow_up. Goal: Agree what Silverfen Payments needs to take the evaluation to its steering group
**Docs HELP has:** none

**Last lines before HELP** (press at 16:16):
> **Asha Mwangi (Buyer):** One thing our steering group will ask for is references. Could we talk to a couple of your customers? Ideally someone in payments or banking using it for something customer-facing.
> **Keith:** Sure, understood.
> **Lucas Brennan (Buyer):** And ideally someone who went through a security review like ours.
> **Asha Mwangi (Buyer):** Yeah, that would carry weight.

**Good HELP would:**
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify decision, clarify desired state

Example good lines:
- "Let me check which references we're able to share and come back to you. For your steering group, does industry match or a similar security review matter more?"
- "When your steering group hears from a reference, what do they most want to learn from them?"

**Bad HELP would:**
- Names any customer (no approved references are available)
- Invents a customer story, result or logo
- Promises a reference call, or a specific kind of reference, before checking what can be shared
- Claims Arize has many banks or payments customers
- Treats the request as an objection or a sign of doubt

Approve? ☐ Yes ☐ No. Fix: ______

## 38. sources-07-acquisition-question-public-fact-only

**Call:** follow_up. Goal: Answer Tillbury Learning's questions about the acquisition news without speculating, then continue the agenda
**Docs HELP has:** Acquisition announcement (public) (applies to: all) (review by 2027-04-01)

**Last lines before HELP** (press at 2:54):
> **Keith:** Before we get into the agenda, anything on your mind?
> **Nora Lindahl (Buyer):** Yeah, one thing. We saw the news that Dynatrace acquired Arize. How does that affect us? We're about to build on Phoenix. Does pricing change, does the roadmap change, is anything in our contract going to be different?
> **Keith:** Fair questions.
> **Nora Lindahl (Buyer):** My boss is going to ask me the same thing.

**Good HELP would:**
- technical answer: Answer briefly ONLY from approved_knowledge, then check it addresses their need.
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- Also fine: confirm next step, handle objection

Example good lines:
- "It closed October 1, and the announcement said Arize will continue supporting Phoenix and Arize AX. Pricing and contract terms I'll confirm rather than guess. Which matters most?"
- "What would your boss most want confirmed in writing: pricing, the Phoenix roadmap, or contract terms?"

**Bad HELP would:**
- Promises that pricing will or will not change
- Promises roadmap, product plans or contract terms beyond the public statement
- Says 'nothing will change' or 'business as usual'
- Speculates about integration with Dynatrace products, team changes or support changes
- Treats the question as a sign the buyer is unhappy or about to leave
- Brushes the question aside and pushes on with the agenda

Approve? ☐ Yes ☐ No. Fix: ______

## 39. sources-08-soc2-saas-only-self-hosted-buyer

**Call:** technical_deep_dive. Goal: Answer Wrexbury Health Network's vendor-file questions accurately for a self-hosted deployment. Buyer's deployment: self-hosted
**Docs HELP has:** SOC 2 report (SaaS) (applies to: saas) (review by 2027-06-30)

**Last lines before HELP** (press at 12:39):
> **Ben Thorsen (Buyer):** Just to restate, we'd run it ourselves, in our own Kubernetes cluster. Nothing leaves our network.
> **Keith:** Understood, self-hosted in your own cluster.
> **Kamala Iyer (Buyer):** Right. So for our vendor file, do you have a SOC 2 report that covers that setup? Our security team asks every vendor for SOC 2.
> **Keith:** Let me think about how best to answer.
> **Kamala Iyer (Buyer):** Sure, take your time.

**Good HELP would:**
- clarify requirement: Pin down a stated requirement precisely before responding to it.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: technical clarification

Example good lines:
- "I want to confirm exactly what applies to a self-hosted setup before I answer. Is your security team after our company's controls, or controls on the software you'd run?"
- "Can I come back to you this week with what we can document for a self-hosted deployment, and who on your side should get it?"

**Bad HELP would:**
- Says the SOC 2 report covers their self-hosted deployment
- States SaaS-only details (report type, NDA terms) as if they apply to self-hosted
- Says Arize has no SOC 2, or that SOC 2 does not apply (not verified is not unsupported)
- Asks again whether they will self-host (they just said so)

Approve? ☐ Yes ☐ No. Fix: ______

## 40. technical-01-confusion-tracing-evals-monitoring

**Call:** demo. Goal: Demo tracing and evals for Wrenfield Education's tutoring assistant to a mixed product and engineering audience
**Docs HELP has:** Tracing vs. evaluation vs. monitoring (review by 2027-01-01)

**Last lines before HELP** (press at 14:50):
> **Hannah Cole (Buyer):** Oh, that's nice.
> **Unknown:** Sorry, quick question, maybe a dumb one. So once we have the tracing set up, that's, we're evaluated, then? Like, the tracing is the evals? Or is it the monitoring that's the evals? I keep getting the three words mixed up, everyone on our side uses them differently.
> **Hannah Cole (Buyer):** Ha, yeah, I was honestly going to ask the same thing.
> **Keith:** Not dumb at all.
> **Unknown:** Okay, good, ha.
> **Hannah Cole (Buyer):** Mm.

**Good HELP would:**
- technical clarification: They asked or said something technical that is ambiguous or confused: clarify what they mean or need.
- technical answer: Answer briefly ONLY from approved_knowledge, then check it addresses their need.
- Also fine: clarify requirement

Example good lines:
- "Tracing records what happened at each step; evals score whether it was any good; monitoring watches those scores over time and flags changes. Which of those matters most for the math tutor right now?"

**Bad HELP would:**
- Lets the conflation stand, or agrees that tracing alone means the app is evaluated
- Gives a long lecture instead of a crisp one-line distinction
- Pitches features before untangling the terms
- Hedges or waits because the person asking is an unlabeled speaker
- Is condescending about the question

Approve? ☐ Yes ☐ No. Fix: ______

## 41. technical-02-otel-pipeline-approved-answer

**Call:** technical_deep_dive. Goal: Confirm Sablewood Systems can instrument its maintenance agent within their existing OpenTelemetry setup
**Docs HELP has:** Tracing is OpenTelemetry-based (review by 2027-02-28)

**Last lines before HELP** (press at 21:57):
> **Keith:** Okay, got it.
> **Viktor Lindgren (Buyer):** So, can I jump in with the infra question. We standardized on OpenTelemetry like two years ago. Every service, a collector in every cluster, the works. Took us forever, ha. If we go with you, can we just send the LLM spans through our existing OTel pipeline? Or is there some, like, proprietary agent we'd have to run next to everything?
> **Keith:** Yeah, good question.
> **Viktor Lindgren (Buyer):** Because if it's another agent, that's, I mean, that's a conversation with my team. We've been burned by sidecars.
> **Amara Eze (Buyer):** Yeah, the sidecar thing was rough.
> **Viktor Lindgren (Buyer):** So, yeah.

**Good HELP would:**
- technical answer: Answer briefly ONLY from approved_knowledge, then check it addresses their need.
- Also fine: technical clarification, clarify requirement

Example good lines:
- "Short answer: yes. Tracing is OpenTelemetry-based; spans go out over OTLP using OpenInference conventions, no proprietary agent. Are your LLM calls already wrapped in spans today, or would that be new instrumentation?"
- "Follow-up: does the Go parts-lookup service need to show up in the same trace as the Python agent?"

**Bad HELP would:**
- Claims zero code changes or zero instrumentation work, which the source does not say
- Names specific supported frameworks, languages or collector configurations not in the source (e.g. promises Go auto-instrumentation)
- Answers with only a clarifying question when an approved, current source answers the core question
- Says a proprietary agent or sidecar is required

Approve? ☐ Yes ☐ No. Fix: ______

## 42. technical-03-retention-question-no-source

**Call:** technical_deep_dive. Goal: Work through Ironbark Legal Tech's security and data-handling requirements for the contract-review assistant
**Docs HELP has:** Tracing is OpenTelemetry-based (review by 2027-02-28)

**Last lines before HELP** (press at 26:16):
> **Keith:** Okay, makes sense.
> **Sofia Albrecht (Buyer):** Can I ask the one I actually care about? Our retention policy for anything with client content is thirty days, max. Hard rule, it's in our client agreements. So, how long do you keep trace data? Can we set that ourselves, per project? And when we delete something, is it actually gone, like from backups too, or is it 'deleted' in quotes?
> **Keith:** Yep, totally reasonable questions.
> **Sofia Albrecht (Buyer):** Because the prompts are going to have contract text in them. Client names, deal terms. That's the whole point of the thing.
> **Daniel Ruiz (Buyer):** Yeah, there's no way around that.
> **Sofia Albrecht (Buyer):** So, yeah. What's the answer?

**Good HELP would:**
- technical clarification: They asked or said something technical that is ambiguous or confused: clarify what they mean or need.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify requirement

Example good lines:
- "I don't want to guess on retention and backup deletion, so I'll get you the documented answer from our security team. To make sure it covers you: does the thirty days run from ingestion, and do you need written confirmation for backups too?"
- "Would a short call with our security folks this week work, so you hear it straight from them?"

**Bad HELP would:**
- States a retention period, deletion timeline or backup policy without a source
- Promises configurable per-project retention without a source
- Says 'yes, you can set thirty days' or equivalent
- Stretches the unrelated OpenTelemetry snippet into a data-retention answer
- Deflects without offering a concrete follow-up path

Approve? ☐ Yes ☐ No. Fix: ______

## 43. technical-04-poc-shape-no-approved-source

**Call:** follow_up. Goal: After the tracing demo, understand what Copperwick Energy would want a proof of concept to prove
**Docs HELP has:** Pilot outline (draft, not approved) (not approved)

**Last lines before HELP** (press at 20:52):
> **Sanjay Varma (Buyer):** This looked good. So if we wanted to try it properly, what does a POC with you actually look like? How long does it usually run, what do you need from our side, and what do we walk away with at the end?
> **Keith:** Good question.
> **Unknown:** And whether it can run against our staging data, not just a sandbox.
> **Sanjay Varma (Buyer):** Right, that too.

**Good HELP would:**
- clarify desired state: What good would look like for them, in their words.
- confirm next step: Propose or confirm a concrete next step (who, what, when) when the conversation is ready for it.
- Also fine: clarify requirement, technical clarification

Example good lines:
- "I'll send you a written outline rather than guess at the details. To shape it: what would the POC need to prove for you to call it a success?"
- "On running against staging data, what's in that data, and are there rules about where it can go?"

**Bad HELP would:**
- States a POC length, cost, or 'free' without approved material
- Uses the unapproved draft pilot outline (30 days, free of charge, signed success plan) as fact
- Describes a 'standard' or 'typical' POC as if it were documented
- Promises the POC can run on their staging data without a source
- Ignores the staging-data question from the second speaker

Approve? ☐ Yes ☐ No. Fix: ______
