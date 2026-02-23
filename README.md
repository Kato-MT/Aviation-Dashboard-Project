Flight Telemetry Monitoring & Anomaly Detection Dashboard
A web dashboard that visualizes aircraft flight data and flags anomalies like overspeed, rapid descent, and fuel burn spikes.
I'm really interested in aerospace and defense software so I wanted to build something that simulates how ground stations actually monitor aircraft. This project helped me learn a lot about working with real data, building interactive UIs, and thinking about how monitoring systems flag problems in real time.
What It Does

Loads flight telemetry from a CSV (altitude, airspeed, fuel)
Charts everything across three live-updating graphs
Automatically detects anomalies using simple rule-based logic:

Overspeed - airspeed goes above 520 kts
Rapid Descent - altitude drops more than 900 ft within 2 data intervals
Fuel Spike - fuel drops more than 2% in one interval


Replay mode so you can scrub through the whole flight with a slider
Play/pause with 1x, 2x, 4x speed
Click any alert to jump straight to that moment
Export an incident report as JSON

*Built With*

HTML / CSS / JavaScript
Chart.js for graphs
PapaParse for parsing CSVs
Deployed on GitHub Pages

Try It Out
Live version: https://kato-mt.github.io/Aviation-Dashboard-Project/
To run locally:

Clone the repo
Open index.html with Live Server in VS Code

*Things I Want to Add*

1. Comparing multiple flights side by side
2. Replacing the hard-coded thresholds with an ML model that learns what normal or baseline looks like for each aircraft
3. More telemetry like engine temp, heading, G-force
4. A dark/light mode toggle

Author
Kato Thompkins - CS @ East Georgia State College / Georgia Southern University
