-- join + filter + group + having, with NULLs in join keys and aggregated columns
SELECT u.name, COUNT(o.id) AS n, SUM(o.amount) AS total
FROM users u JOIN orders o ON o.uid = u.id
WHERE u.age >= 18
GROUP BY u.name
HAVING COUNT(o.id) > 0;
