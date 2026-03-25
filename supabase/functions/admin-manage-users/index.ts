import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Verify super_admin
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) throw new Error('Unauthorized')

    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'super_admin') throw new Error('Forbidden')

    const { action, orgId, userId, isActive, newPassword } = await req.json()

    // LIST USERS
    if (action === 'list') {
      const { data: users, error } = await supabase
        .from('users')
        .select('id, name, email, role, is_active, last_login_at, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: true })

      if (error) throw error
      return new Response(JSON.stringify({ ok: true, users }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // TOGGLE ACTIVE
    if (action === 'toggle') {
      const { error } = await supabase
        .from('users')
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq('id', userId)

      if (error) throw error
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // RESET PASSWORD
    if (action === 'reset-password') {
      // Get user auth id
      const { data: userProfile } = await supabase
        .from('users')
        .select('id')
        .eq('id', userId)
        .single()

      if (!userProfile) throw new Error('User not found')

      // Update auth password (requires service role)
      const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
        password: newPassword
      })

      if (authError) throw authError

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // IMPERSONATE
    if (action === 'impersonate') {
      // Find admin user for org
      // Find highest-role user: admin > manager > any
      let { data: adminUser } = await supabase
        .from('users')
        .select('id, email')
        .eq('org_id', orgId)
        .in('role', ['admin', 'manager'])
        .eq('is_active', true)
        .order('role', { ascending: true })
        .limit(1)
        .single()

      if (!adminUser) {
        // Fallback: any active user in the org
        const { data: anyUser } = await supabase
          .from('users')
          .select('id, email')
          .eq('org_id', orgId)
          .eq('is_active', true)
          .neq('role', 'super_admin')
          .limit(1)
          .single()
        adminUser = anyUser
      }

      if (!adminUser) throw new Error('Nenhum usuário ativo encontrado nesta organização')

      // Generate magic link for admin
      const { data: org } = await supabase
        .from('organizations')
        .select('slug')
        .eq('id', orgId)
        .single()

      if (!org) throw new Error('Org not found')

      // Get admin email
      const { data: { user: authUser } } = await supabase.auth.admin.getUserById(adminUser.id)
      if (!authUser?.email) throw new Error('Admin email not found')

      // Generate magic link
      const { data: magicLinkData, error: magicError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: authUser.email,
      })

      if (magicError) throw magicError

      const magicLink = `https://${org.slug}.raizesolucoes.com.br/auth/callback?token=${magicLinkData.properties?.hashed_token}`

      return new Response(JSON.stringify({ ok: true, magicLink }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    throw new Error('Invalid action')
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
