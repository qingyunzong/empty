# Example shadowc policy.
field port: int
field proto: string
field role: enum(admin, user, guest)

action allow
action deny
action log

rule ssh_admin when port == 22 and role == admin then allow, log
rule web when port in 80..443 and proto == "http*" then allow
rule web_shadowed when port in 80..100 and proto == "http*" then deny
rule legacy when port in 90..2000 and proto == "http*" then log
rule catchall when port in 0..65535 then deny
