import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  const from = process.env.RESEND_FROM || "SignalForge <onboarding@resend.dev>";

  if (!apiKey || !to) {
    return NextResponse.json(
      { ok: false, error: "Email is not configured" },
      { status: 500 },
    );
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "SignalForge test alert",
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.5;max-width:680px">
            <h2>SignalForge test successful</h2>
            <p>Your production notification pipeline is connected.</p>
            <p><strong>Vercel → Resend → inbox</strong></p>
            <p>This is only a test. No trade was executed.</p>
          </div>
        `,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Resend test failed:", data);
      return NextResponse.json(
        { ok: false, error: "Resend rejected the test email", details: data },
        { status: response.status },
      );
    }

    return NextResponse.json({
      ok: true,
      message: "SignalForge test email sent",
      id: data?.id ?? null,
    });
  } catch (error) {
    console.error("SignalForge test email failed:", error);
    return NextResponse.json(
      { ok: false, error: "Unable to send test email" },
      { status: 500 },
    );
  }
}
