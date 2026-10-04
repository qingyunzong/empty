SELECT m.station, COUNT(*) AS n, AVG(m.temp) AS avg_temp
FROM measure m JOIN station s ON m.station = s.code
WHERE m.hum IS NULL OR m.hum > 30
GROUP BY m.station
HAVING AVG(m.temp) > 5
