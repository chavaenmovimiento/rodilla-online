import Stripe from "stripe";

export const config = {
  api: { bodyParser: false }
};

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

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Stripe secret is missing" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const signature = req.headers["stripe-signature"];
  const signingSecrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_TEST_SECRET
  ].filter(Boolean);

  if (!signature || signingSecrets.length === 0) {
    return res.status(400).json({ error: "Webhook signature is missing" });
  }

  const body = await rawBody(req);
  let event;
  let signatureError;
  for (const secret of signingSecrets) {
    try {
      event = stripe.webhooks.constructEvent(body, signature, secret);
      break;
    } catch (error) {
      signatureError = error;
    }
  }

  if (!event) {
    return res.status(400).json({
      error: `Invalid webhook: ${signatureError?.message || "signature verification failed"}`
    });
  }

  try {
    // Los eventos del entorno de prueba solo validan la entrega. Nunca deben
    // modificar los horarios reales guardados en Supabase.
    if (!event.livemode) {
      return res.status(200).json({ received: true, test: true });
    }

    const session = event.data.object;
    const slotId = session.client_reference_id;

    if (
      (event.type === "checkout.session.completed" && session.payment_status === "paid") ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      if (!slotId) {
        return res.status(200).json({ received: true, ignored: "no_slot_reference" });
      }
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
