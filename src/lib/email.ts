/**
 * Email helpers via Resend REST API.
 * Usamos fetch directamente (sin SDK) para compatibilidad con Cloudflare Workers.
 */

export interface WhatsappRequestEmailInput {
  businessId:   string
  businessName: string
  planId:       string | null
  type:         'new' | 'existing'
  phone?:       string   // solo si type === 'existing'
  contactName:  string
  contactPhone: string
  notes?:       string
}

export async function sendWhatsappRequestEmail(
  input: WhatsappRequestEmailInput,
  resendApiKey: string
): Promise<void> {
  const typeLabel   = input.type === 'existing' ? 'Número existente' : 'Número nuevo'
  const planLabel   = input.planId ?? 'sin plan'

  const bodyLines = [
    `<p><strong>Negocio:</strong> ${input.businessName} (ID: ${input.businessId})</p>`,
    `<p><strong>Plan:</strong> ${planLabel}</p>`,
    `<p><strong>Tipo:</strong> ${typeLabel}</p>`,
    input.phone ? `<p><strong>Número a migrar:</strong> ${input.phone}</p>` : '',
    `<p><strong>Contacto:</strong> ${input.contactName}</p>`,
    `<p><strong>Teléfono/Email de contacto:</strong> ${input.contactPhone}</p>`,
    input.notes ? `<p><strong>Notas:</strong> ${input.notes}</p>` : '',
  ].filter(Boolean).join('\n')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from:    'aesthetic <noreply@aestheticapp.com.ar>',
      to:      ['aesthetic.rocketly@gmail.com'],
      subject: `[aesthetic] Nueva solicitud WhatsApp — ${input.businessName}`,
      html: `
        <h2>Nueva solicitud de WhatsApp</h2>
        ${bodyLines}
        <hr/>
        <p style="color:#888;font-size:12px">aesthetic · sistema de gestión</p>
      `,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error: ${res.status} — ${err}`)
  }
}

// ── Password reset ──────────────────────────────────────────────────────────

export async function sendPasswordResetEmail(
  input: { email: string; name: string; resetUrl: string },
  resendApiKey: string
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from:    'aesthetic <noreply@aestheticapp.com.ar>',
      to:      [input.email],
      subject: 'Recuperar contraseña — aesthetic',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="margin:0 0 8px;font-size:22px;font-weight:600">Recuperar contraseña</h2>
          <p style="margin:0 0 24px;color:#666;font-size:14px">Hola ${input.name}, recibimos una solicitud para restablecer tu contraseña.</p>
          <a href="${input.resetUrl}"
             style="display:inline-block;background:#3d5a3e;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500">
            Restablecer contraseña
          </a>
          <p style="margin:24px 0 0;color:#999;font-size:12px;line-height:1.6">
            Este link expira en <strong>1 hora</strong>.<br/>
            Si no solicitaste el cambio, podés ignorar este email.
          </p>
          <hr style="margin:24px 0;border:none;border-top:1px solid #eee"/>
          <p style="color:#bbb;font-size:11px;margin:0">aesthetic · sistema de gestión</p>
        </div>
      `,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error: ${res.status} — ${err}`)
  }
}

// ── Deactivation request ────────────────────────────────────────────────────

export interface WhatsappDeactivationEmailInput {
  businessId:   string
  businessName: string
  whatsappPhone: string | null
  contactName:  string
  contactPhone: string
  notes?:       string
}

export async function sendWhatsappDeactivationEmail(
  input: WhatsappDeactivationEmailInput,
  resendApiKey: string
): Promise<void> {
  const bodyLines = [
    `<p><strong>Negocio:</strong> ${input.businessName} (ID: ${input.businessId})</p>`,
    `<p><strong>Número actual:</strong> ${input.whatsappPhone ?? 'no registrado'}</p>`,
    `<p><strong>Contacto:</strong> ${input.contactName}</p>`,
    `<p><strong>Teléfono/Email de contacto:</strong> ${input.contactPhone}</p>`,
    input.notes ? `<p><strong>Notas:</strong> ${input.notes}</p>` : '',
  ].filter(Boolean).join('\n')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from:    'aesthetic <noreply@aestheticapp.com.ar>',
      to:      ['aesthetic.rocketly@gmail.com'],
      subject: `[aesthetic] Solicitud de baja WhatsApp — ${input.businessName}`,
      html: `
        <h2>Solicitud de baja del bot de WhatsApp</h2>
        ${bodyLines}
        <hr/>
        <p style="color:#888;font-size:12px">aesthetic · sistema de gestión</p>
      `,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error: ${res.status} — ${err}`)
  }
}
