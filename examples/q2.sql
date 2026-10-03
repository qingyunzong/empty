-- three-valued HAVING: bob's group has AVG(age) = NULL -> UNKNOWN -> reported, not dropped
SELECT u.name, AVG(u.age) AS avg_age
FROM users u
GROUP BY u.name
HAVING AVG(u.age) > 35;
