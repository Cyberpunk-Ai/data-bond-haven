-- Prevent clients from self-escalating their subscription plan by writing
-- directly to profiles.plan or the subscriptions table. Only the service
-- role (server functions / webhooks, which verify payment first) may change
-- these values. Idempotent.

CREATE OR REPLACE FUNCTION public.guard_profile_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan AND auth.role() <> 'service_role' THEN
    NEW.plan := OLD.plan;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS t_guard_profile_plan ON public.profiles;
CREATE TRIGGER t_guard_profile_plan
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_plan_change();

-- Subscriptions: allow authenticated users to read their own row (already in
-- place) but only service_role may insert/update/delete rows, since a
-- subscription state must only ever follow a verified payment.
DROP POLICY IF EXISTS "subscriptions no client write" ON public.subscriptions;
CREATE POLICY "subscriptions no client write"
  ON public.subscriptions
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
