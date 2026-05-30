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
      from:    'aesthetic <onboarding@resend.dev>',
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
