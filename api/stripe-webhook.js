import Stripe from "stripe";

export const config = {
  api: { bodyParser: false }
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function updateSlot(slotId, values) {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !serviceKey) {
    throw new Error("Supabase environment variables are missing");
  }

  const response = await fetch(
    `${baseUrl}/rest/v1/slots?id=eq.${encodeURIComponent(slotId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(values)
    }
  );

  if (!response.ok) {
    throw new Error(`Supabase update failed: ${response.status}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).json({ error: "Webhook signature is missing" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await rawBody(req),
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return res.status(400).json({ error: `Invalid webhook: ${error.message}` });
  }

  try {
    const session = event.data.object;
    const slotId = session.client_reference_id;

    if (
      (event.type === "checkout.session.completed" && session.payment_status === "paid") ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      if (!slotId) throw new Error("Stripe session has no slot reference");
      await updateSlot(slotId, { status: "ocupado" });
    }

    if (event.type === "checkout.session.expired" && slotId) {
      await updateSlot(slotId, {
        status: "disponible",
        patient_name: null,
        patient_wa: null,
        package: null
      });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
