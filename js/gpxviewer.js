/*
	TODO:
	- OK: 	drag-and-drop api
	- OK: 	base map
	- OK: 	auto set to data extent
	- OK:	finer-levels of scrubbing
	- OK:	cancel fine scrubbing when mouseup
	- OK:	auto zoom to extent
	- OK:	path to update transform instead of reprojecting the geometry when panning 
	- 		custom cursors for scrubbing directions
	- 		elevation chart
	- 		track data table
	-		auto-load basemap, and smooth zoom to new gpx region when file is dropped
*/
	
var d3gpx = d3gpx || ( function() {

	var autoPlayId = -1, playing = false;

	var minMaxDates; 
	var dateList = []; 		// ISO 8601
	var lonList = []; 		// decimal degrees
	var latList = []; 		// decimal degrees
	var eleList = [];		// meters
	var courseList = [];	// degrees
	var speedList = [];		// m/s
	var pdopList = [];
	var lineString = [];
	var lonScale, latScale, eleScale, speedScale;

	var customTimeFormat = d3.time.format.multi([
		[".%L", function(d) { return d.getMilliseconds(); }],
		[":%S", function(d) { return d.getSeconds(); }],
		["%I:%M", function(d) { return d.getMinutes(); }],
		["%I %p", function(d) { return d.getHours(); }],
		["%a %d", function(d) { return d.getDay() && d.getDate() != 1; }],
		["%b %d", function(d) { return d.getDate() != 1; }],
		["%B", function(d) { return d.getMonth(); }],
		["%Y", function() { return true; }]
	]);

	var margin = {top: 10, right: 10, bottom: 10, left: 10},
		width = 650 - margin.left - margin.right,
		height = 50 - margin.bottom - margin.top,
		currentValue = 0,
		targetValue = 0,
		moving = false, // is it currently moving?
		alpha = 0.2,
		scrubCat = 0, // 0, 1, 2, 3
		scrubSensitivity = [0.1, 0.001, 0.0000625, 0.00000625], //[0.2, 0.002, 0.000125, 0.0000125],
		y0 = 0.0,
		zoomEventXY = [],
		zoomReset = true,
		zoomEventScale,
		handleRadius = 6;
		
	var chartWidth, chartHeight, eleChartX, eleChartY, speedChartX, speedChartY;
	var pathGeometry;
	var projection, path, zoomControl;
	var x, brush, slider, handle;
	var testDiv, testArea, raster;

	var brushed = function(init) {
		if (d3.event && d3.event.sourceEvent) { // not a programmatic event
			targetValue = x.invert(d3.mouse(this)[0]);
			
			var maxHeight = Math.abs(window.innerHeight - y0) * (2/3);
			//var sensitivityRange = [0.2, 0.00001];
			//var sensitivity = d3.scale.pow().exponent(0.5).domain([0, maxHeight]).range(sensitivityRange)(Math.min(Math.abs(d3.event.sourceEvent.y - y0), maxHeight));
			//var indicator = d3.scale.linear().domain(sensitivityRange).range([handleRadius, 1])(sensitivity);

			var dy = Math.min(Math.abs(d3.event.sourceEvent.y - y0), maxHeight);
			var dPer = dy/maxHeight, dIndicatorRadius = handleRadius;
			scrubCat = 0;
			
			if (dPer >= 0.0 && dPer < 0.25) {
				scrubCat = 0;
				dIndicatorRadius = handleRadius;
			} else if (dPer >= 0.25 && dPer < 0.5) {
				scrubCat = 1;
				dIndicatorRadius = 4.242640687119285;
			} else if (dPer >= 0.5 && dPer < 0.75) {
				scrubCat = 2;
				dIndicatorRadius = 3;
			} else if (dPer >= 0.75 && dPer <= 1.0) {
				scrubCat = 3;
				dIndicatorRadius = 2.1213203435596424;
			}

			handle.transition().duration(200).attr("r", dIndicatorRadius);

			stopPlay();
			move();

			return;
		} else if (init) {
			slider.call(brush.extent([minMaxDates[0], minMaxDates[0]])).call(brush.event);
		}

		currentValue = brush.extent()[0];
		handle.attr("cx", x(currentValue));

		var format = d3.time.format("%d %b %Y %I:%M:%S %p");
		var currentValueRounded = Math.round(currentValue);
		var text1 = format(new Date(currentValueRounded));

		d3.select("div#console").text(text1);
		d3.select("svg#testArea circle.track")
			.attr("transform", function(d) {
				return "translate(" + projection([lonScale(new Date(currentValueRounded)), latScale(new Date(currentValueRounded))]) + ")"
			});
			
		focusDataChart(new Date(currentValueRounded));
	};

	var stopMove = function() {
		targetValue = currentValue;
	};

	var move = function(sensitivity) {
		if (moving) return false;
		moving = true;
		
		d3.select("button#playpausebtn").attr("disabled", "true");

		d3.timer(function() {
			var sensitivity = scrubSensitivity[scrubCat];
			if (sensitivity > alpha || sensitivity < 0.0) sensitivity = alpha;

			currentValue = Math.abs(currentValue - targetValue) < 1e-3
				? targetValue
				: targetValue * sensitivity + currentValue * (1 - sensitivity);

			slider.call(brush.extent([currentValue, currentValue])).call(brush.event);

			var newMoving = Math.round(currentValue/1000) !== Math.round(targetValue/1000);
			if (!newMoving) d3.select("button#playpausebtn").attr("disabled", null);

			return !(moving = newMoving);
		}, 200);
	};
	
	var stopPlay = function() {
		clearTimeout(autoPlayId);
		autoPlayId = -1;
		playing = false;
		moving = false;

		//set play button text to: play
		d3.select("button#playpausebtn").text("Play");
	};
	
	var play = function(immediate) {
		autoPlayId = setTimeout(function() {
			//console.log(moving + " - " + playing + " - " + autoPlayId);
			if (moving) return false;
			moving = true;
			playing = true;
			
			//set play button text to: pause
			d3.select("button#playpausebtn").text("Pause");

			targetValue = minMaxDates[1];
			var startValue = new Date(brush.extent()[0]);
			var timeNow = new Date();

			d3.timer(function() {
				var lapsed = ( (new Date() - timeNow) * 1000 );
				currentValue = startValue.getTime() + lapsed;
				slider.call(brush.extent([currentValue, currentValue])).call(brush.event);

				var newMoving = Math.round(currentValue/1000) < Math.round(targetValue/1000);
				var finished = !moving || !(moving = newMoving) || !playing || autoPlayId == -1;
				if (finished) {
					d3.select("button#playpausebtn").text("Play");
					stopPlay();
				}
				
				return finished;
			});
		}, (immediate) ? 0 : 3000);
	};
	
	var leftShiftCorrectly = function(a, b) {
		return ((a << b) < 0) ? leftShiftCorrectly(a, --b) : (a << b);
	}

	var setInitialExtent = function() {
		
		var tWidthAndHeight = getWidthAndHeight(testArea);
		var tWidth = tWidthAndHeight[0];
		var tHeight = tWidthAndHeight[1];

		var b = path.bounds(pathGeometry); // [[left, top],[right, bottom]]
		var s = leftShiftCorrectly((0.95 / Math.max((b[1][0] - b[0][0]) / tWidth, (b[1][1] - b[0][1]) / tHeight)), 10);
			s = Math.pow(2, Math.floor(Math.log(s)/Math.log(2))); // to smallest scale that is a power of 2.
			s = Math.min(s, zoomControl.scaleExtent()[1]); // shouldn't exceed max zoom limits;
			s = Math.max(s, zoomControl.scaleExtent()[0]); // shouldn't exceed min zoom limits;
		var c = projection.scale(s / 2 / Math.PI)(d3.geo.centroid(pathGeometry));

		// useful for zooming/panning to current point
		//var s = 1048576;
		//var c = projection.scale(s / 2 / Math.PI)([lonList[0], latList[0]]);

		var orig = projection([0, 0]);
		var t = [tWidth/2 - (c[0] - orig[0]), tHeight/2 - (c[1] - orig[1])];

		zoomControl.scale(s).translate(t);
	};

	var redraw = function() {
		var zoomBehaviour = true; // true is zoom, false is pan
		if (d3.event) {
			if (zoomEventScale == d3.event.scale) { // panning
				zoomBehaviour = false;
				zoomReset = false;
			} else { // zooming
				zoomBehaviour = true;
				zoomReset = true;
			}
			
			if (zoomReset) {
				zoomEventXY = d3.event.translate;
				zoomReset = false;
			}
			
			zoomEventScale = d3.event.scale;
		}

		var tiles = d3.geo.tile()
						.size(getWidthAndHeight(testArea))
						.scale(zoomControl.scale())
						.translate(zoomControl.translate())
						();

		projection.scale(zoomControl.scale() / 2 / Math.PI).translate(zoomControl.translate());
		
		//console.log(zoomControl.scale() + " ----- " + zoomControl.translate() + " ----- " + projection.scale() + " ----- " + projection.translate());
		
		if (zoomBehaviour || !(d3.event)) {
			testArea.select("path.trackpath").attr("d", path).attr("transform", null);
		} else {
			var x = d3.event.translate[0] - zoomEventXY[0];
			var y = d3.event.translate[1] - zoomEventXY[1];
			var asd = testArea.select("path.trackpath").attr("transform");
			testArea.select("path.trackpath").attr("transform", "translate(" + [x, y] + ")");
		}
		
		
		var currentValueRounded = Math.round(brush.extent()[0]);
		testArea.select("circle.track")
			.attr("transform", function(d) {
				return "translate(" + projection([lonScale(new Date(currentValueRounded)), latScale(new Date(currentValueRounded))]) + ")"
			});
		
			
			
		var image = raster.attr("transform", "scale(" + tiles.scale + ")translate(" + tiles.translate + ")")
							.selectAll("image")
							.data(tiles, function(d) { return d; });

		image.exit().remove();

		image.enter().append("image") // examples.map-9ijuk24y // examples.map-vyofok3q
				.attr("xlink:href", function(d) { return "http://" + ["a", "b", "c", "d"][Math.random() * 4 | 0] + ".tiles.mapbox.com/v3/chrissng0.hf8gnd1h/" + d[2] + "/" + d[0] + "/" + d[1] + ".png"; })
				.attr("width", 1)
				.attr("height", 1)
				.attr("x", function(d) { return d[0]; })
				.attr("y", function(d) { return d[1]; });
	};

	var getWidthAndHeight = function(element) {
		return [parseInt(element.style("width"), 10), parseInt(element.style("height"), 10)];
	};

	var loadSpeedChart = function(parentElement, dateData, speedData) { 
		//parentElement could be testDiv

		if (dateData.length != speedData.length) return;

		var dateExtent = d3.extent(dateData);
		var speedExtent = d3.extent(speedData);
		if (dateExtent[0] == undefined || 
			dateExtent[1] == undefined || 
			speedExtent[0] == undefined || 
			speedExtent[1] == undefined) {
			return;
		}

		var data = [];
		for (var i = 0; i < dateData.length; i++) {
			data.push({ date: dateData[i], speed: speedData[i] });
		}
		
		chartWidth = 300;
		chartHeight = 100;

		speedChartX = d3.time.scale().range([0, chartWidth]).domain(dateExtent).clamp(true);
		speedChartY = d3.scale.linear().range([chartHeight, 0]).domain(speedExtent).clamp(true); // 0 is from top
		
		speedScale = d3.time.scale().domain(dateData).range(speedData).clamp(true);

		var line = d3.svg.line()
						.x(function(d) { return speedChartX(d.date); })
					    .y(function(d) { return speedChartY(d.speed); });

		parentElement.style("float", "left")
						.style("width", (chartWidth+(margin.left*3)*2)+"px")
						//.style("bottom", "0px")
						//.style("right", ((d3.select("svg#elevationChart g").empty()) ? 0 : (chartWidth+(margin.left*3)+(margin.left*3)))+"px")
						.style("background-color", "rgba(255,255,255,0.4)");

		var svg = parentElement.append("svg")
						.attr("id", "speedChart")
						.attr("class", "dataChart")
						.attr("width", chartWidth+"px")
						.attr("height", chartHeight+"px")
						.style("padding-left", (margin.left*4)+"px")
						.style("padding-right", (margin.left*3)+"px")
						.style("padding-top", (margin.left*2)+"px")
						.style("padding-bottom", (margin.left*2)+"px")
						.append("g");

							
		var xAxis = d3.svg.axis().scale(speedChartX).orient("bottom").tickFormat(customTimeFormat).ticks(5).outerTickSize(0);
		var yAxis = d3.svg.axis().scale(speedChartY).orient("left").tickFormat(function(d) { return d3.format("s")(d*3.6); }).ticks(5).outerTickSize(0).innerTickSize(-chartWidth);
		svg.append("g")
			.attr("class", "x chartAxis")
			.attr("transform", "translate(0," + (chartHeight+3) + ")")
			.call(xAxis);
		svg.append("g")
			.attr("class", "y chartAxis")
			.call(yAxis)
			.append("text")
				.attr("transform", "rotate(-90)")
				.attr("y", 6)
				.attr("dy", ".71em")
				.style("text-anchor", "end")
				.text("Speed (kph)");
							
		svg.append("path")
			.datum(data)
			.attr("class", "chartLine")
			.attr("d", line);
	};

	var loadElevationChart = function(parentElement, dateData, eleData) { 
		//parentElement could be testDiv

		if (dateData.length != eleData.length) return;

		var dateExtent = d3.extent(dateData);
		var eleExtent = d3.extent(eleData);
		if (dateExtent[0] == undefined || 
			dateExtent[1] == undefined || 
			eleExtent[0] == undefined || 
			eleExtent[1] == undefined) {
			return;
		}

		var data = [];
		for (var i = 0; i < dateData.length; i++) {
			data.push({ date: dateData[i], ele: eleData[i] });
		}
		
		chartWidth = 300;
		chartHeight = 100;

		eleChartX = d3.time.scale().range([0, chartWidth]).domain(dateExtent).clamp(true);
		eleChartY = d3.scale.linear().range([chartHeight, 0]).domain(eleExtent).clamp(true); // 0 is from top
		
		eleScale = d3.time.scale().domain(dateData).range(eleData).clamp(true);

		var line = d3.svg.line()
						.x(function(d) { return eleChartX(d.date); })
					    .y(function(d) { return eleChartY(d.ele); });

		parentElement.style("float", "left")
						.style("width", (chartWidth+(margin.left*3)*2)+"px")
						//.style("bottom", "0px")
						//.style("right", "0px")
						.style("background-color", "rgba(255,255,255,0.4)");
						//.style("border-radius", "0px");
						//.style("border", "1px solid rgba(255,255,255,0.5)");

		var svg = parentElement.append("svg")
						.attr("id", "elevationChart")
						.attr("class", "dataChart")
						.attr("width", chartWidth+"px")
						.attr("height", chartHeight+"px")
						.style("padding-left", (margin.left*3)+"px")
						.style("padding-right", (margin.left*3)+"px")
						.style("padding-top", (margin.left*2)+"px")
						.style("padding-bottom", (margin.left*2)+"px")
						.append("g");
							//.attr("transform", "translate(" + margin.left + "," + margin.top + ")");

							
		var xAxis = d3.svg.axis().scale(eleChartX).orient("bottom").tickFormat(customTimeFormat).ticks(5).outerTickSize(0);
		var yAxis = d3.svg.axis().scale(eleChartY).orient("left").tickFormat(d3.format("s")).ticks(5).outerTickSize(0).innerTickSize(-chartWidth);
		svg.append("g")
			.attr("class", "x chartAxis")
			.attr("transform", "translate(0," + (chartHeight+3) + ")")
			.call(xAxis);
		svg.append("g")
			.attr("class", "y chartAxis")
			.call(yAxis)
			.append("text")
				.attr("transform", "rotate(-90)")
				.attr("y", 6)
				.attr("dy", ".71em")
				.style("text-anchor", "end")
				.text("Elevation (m)");

							
		svg.append("path")
			.datum(data)
			.attr("class", "chartLine")
			.attr("d", line);
	};
	
	var focusDataChart = function(currentDate) {
		var elevationFocusID = "elevationFocus";
		var speedFocusID = "speedFocus";
		
		var elevatonSvg = d3.select("svg#elevationChart g");
		var speedSvg = d3.select("svg#speedChart g");

		var elevationFocus = elevatonSvg.select("g#"+elevationFocusID);
		var speedFocus = speedSvg.select("g#"+speedFocusID);
		
		if (!elevatonSvg.empty() && elevationFocus.empty()) {
			elevationFocus = elevatonSvg.append("g").attr("id", elevationFocusID);
			
			elevationFocus.append("circle")
					.attr("id", elevationFocusID+"Circle")
					.attr("class", "chartCircle")
					.attr("r", 2.5);		
			elevationFocus.append("text")
					.attr("id", elevationFocusID+"Text")
					.attr("class", "chartCircleText")
					.attr("text-anchor", "middle")
					.attr("dy", "-0.7em");
		}

		if (!speedSvg.empty() && speedFocus.empty()) {
			speedFocus = speedSvg.append("g").attr("id", speedFocusID);
			
			speedFocus.append("circle")
					.attr("id", speedFocusID+"Circle")
					.attr("class", "chartCircle")
					.attr("r", 2.5);		
			speedFocus.append("text")
					.attr("id", speedFocusID+"Text")
					.attr("class", "chartCircleText")
					.attr("text-anchor", "middle")
					.attr("dy", "-0.7em");
		}
		
		if (!elevatonSvg.empty()) {
			var ele = eleScale(currentDate);
			elevationFocus.attr("transform", "translate(" + eleChartX(currentDate) + "," + eleChartY(ele) + ")");
			elevationFocus.select("text#"+elevationFocusID+"Text").text(d3.format(",.2f")(ele)+" m");
		}

		if (!speedSvg.empty()) {
			var speed = speedScale(currentDate);
			speedFocus.attr("transform", "translate(" + speedChartX(currentDate) + "," + speedChartY(speed) + ")");
			speedFocus.select("text#"+speedFocusID+"Text").text(d3.format(",.2f")(speed*3.6)+" kph");
		}
	};

	return {
		play: function() {
			//console.log("playing...");
			play(true);
		},

		pause: function() {
			//console.log("pause...");
			stopPlay();
		},

		loadGPXViewer: function(data) {
			dateList = [];
			lonList = [];
			latList = [];
			eleList = [];
			courseList = [];
			speedList = [];
			pdopList = [];
			lineString = [];


			stopPlay();
			stopMove();
			
				
				
			// Load GPX data
			var trkPtData = d3.select(data).selectAll("trk").selectAll("trkseg").selectAll("trkpt").each(function() {
				var lat = parseFloat(d3.select(this).attr("lat"));
				var lon = parseFloat(d3.select(this).attr("lon"));
				
				latList.push(lat);
				lonList.push(lon);
				lineString.push([lon, lat]);
				
				dateList.push((!d3.select(this).select("time").node()) ? null : new Date(d3.select(this).select("time").text()));
				eleList.push((!d3.select(this).select("ele").node()) ? null : parseFloat(d3.select(this).select("ele").text()));
				courseList.push((!d3.select(this).select("course").node()) ? null : parseFloat(d3.select(this).select("course").text()));
				speedList.push((!d3.select(this).select("speed").node()) ? null : parseFloat(d3.select(this).select("speed").text()));
				pdopList.push((!d3.select(this).select("pdop").node()) ? null : parseFloat(d3.select(this).select("pdop").text()));
			});

			if (lineString.length <= 1) {
				alert("GPX file should contain at least a track, made of at least one segment containing waypoints.");
				return false;
			}

			d3.select("body").selectAll("div#gpxCtr *, div#appTitle div#playbackControl").remove();


			minMaxDates = d3.extent(dateList);//[dateList[0], dateList[dateList.length-1]];
			console.log("dates #: " + dateList.length + " \t longitudes #: " + lonList.length + " \t latitudes #: " + latList.length + " \t elevation #: " + eleList.length + " \t speed #: " + speedList.length);
			
			lonScale = d3.time.scale().domain(dateList).range(lonList).clamp(true);
			latScale = d3.time.scale().domain(dateList).range(latList).clamp(true);
			
			pathGeometry = { "type": "LineString", "coordinates": lineString };
			
			
			
			// Map projection stuffs
			projection = d3.geo.mercator().scale((1 << 10) / 2 / Math.PI);
			
			path = d3.geo.path().projection(projection);
			
			//http://stackoverflow.com/questions/20409484/d3-js-zoomto-point-in-a-2d-map-projection
			zoomControl = d3.behavior.zoom()
								.scaleExtent([1 << 10, 1 << 26])
								.scale(projection.scale() * 2 * Math.PI)
							    .translate([window.innerWidth / 2, window.innerHeight / 2])
								.on("zoom", redraw);

				
				
			// Timeline, brush, labels and stuffs
			x = d3.time.scale()
				.domain(minMaxDates)
				.range([0, width])
				.clamp(true);
				
			brush = d3.svg.brush()
				.x(x)
				.extent([0, 0])
				.on("brush", brushed)
				.on("brushstart", function() {
					if (d3.event && d3.event.sourceEvent) { // not a programmatic event
						y0 = d3.event.sourceEvent.y;
					}
				})
				.on("brushend", function() {
					if (d3.event && d3.event.sourceEvent) { // not a programmatic event
						if (scrubCat != 0) stopMove();
						handle.transition().duration(200).attr("r", handleRadius);
					}
				});


			
			
			var appTitleControlContainer = d3.select("div#appTitle").append("div").attr("id", "playbackControl");
			var gpxContainer = d3.select("body div#gpxCtr");
			
			
			
			// Controls	
			var div = appTitleControlContainer.append("div").attr("id", "console")
							.style("font-size", "smaller")
							.style("font-weight", "normal")
							.style("position", "absolute")
							.style("line-height", "45px")
							.style("right", "10px")
							.style("top", "0px")
							.style("padding-right", "10px");

			var playButton = appTitleControlContainer.append("button")
							.attr("id", "playpausebtn")
							.style("right", (width + margin.left + margin.right + 10 + 170 + 10) + "px")
							.text("Play")
							.on("click", function(d) {
								if (playing || autoPlayId != -1) { //pause
									stopPlay();
								} else { //play
									play(true);
								}
							});

			var svg = appTitleControlContainer.append("svg")
							.attr("id", "timeslider")
							.attr("width", width + margin.left + margin.right + 10)
							.attr("height", height + margin.top)
							.style("position", "absolute")
							//.style("right", margin.right+"px")
							.style("right", "170px")
							.style("top", "0px")
							.append("g")
								.attr("transform", "translate(" + margin.left + "," + 0 + ")");

			var axisLines = svg.append("g")
								.attr("class", "axisLine")
								.attr("transform", "translate(0," + ((height / 2) + 3) + ")")
								.style("font-size", "0 pt")
								.call(d3.svg.axis()
										.scale(x)
										.tickFormat(customTimeFormat)
										.tickValues(null));
			axisLines.selectAll("text").remove();
			axisLines.selectAll("path").remove();

			svg.append("g")
				.attr("class", "x axis")
				.attr("transform", "translate(0," + (height / 2) + ")")
				.style("font-size", "6 pt")
				//.style("font-weight", "bold")
				.style("fill", "#fff")
				.call(d3.svg.axis()
					.scale(x)
					.tickFormat(customTimeFormat)
					.tickPadding(12)
					.tickSize(0))
				.select(".domain")
				.style("stroke", "#111")
				//.style("stroke-opacity", 0.5)
				.select(function() { return this.parentNode.appendChild(this.cloneNode(true)); })
				.attr("class", "halo")
				.style("stroke-opacity", 1.0)
				.style("stroke", "#fff");

			slider = svg.append("g")
				.attr("class", "slider")
				.call(brush);

			slider.selectAll(".extent,.resize").remove();
			slider.select(".background").attr("height", height).attr("fill", "#111").style("cursor", "ew-resize");

			handle = slider.append("circle")
				.attr("class", "handle")
				.attr("transform", "translate(0," + (height / 2) + ")")
				.attr("r", handleRadius)
				.style("fill", "#fff");
			
			
			
			// Map area
			testDiv = gpxContainer.append("div").style("width", "100%").style("height", "100%");
			
			testArea = testDiv.append("svg")
							.attr("id", "testArea")
							.style("height", "100%")
							.style("width", "100%")
							//.attr("width", width + margin.left)
							//.attr("height", testMapHeight)
							//.style("border", "1px solid black")
							.call(zoomControl);

			raster = testArea.append("g"); // Base map
			
			testArea.append("path")
				.datum(pathGeometry)
				.attr("class", "trackpath")
				.attr("d", path)
				.attr("fill", "none")
				.attr("stroke", "rgb(222,45,38)")
				.attr("stroke-width", 1);

			testArea.append("circle")
					.attr("class", "track")
					.attr("id", "testTrack")
					.attr("r", 4)
					.style("fill", "rgb(222,45,38)")
					.style("stroke-width", 1)
					.style("stroke", "rgb(0,0,0)");

			var chartGroup = gpxContainer.append("div").attr("id", "chartGroup");			

			loadElevationChart(chartGroup.append("div"), dateList, eleList);
			loadSpeedChart(chartGroup.append("div"), dateList, speedList);

			// do not shift this order!
			setInitialExtent(); 							// fit initial view to all gps data
			redraw(); 										// initialise basemap, path and point
			play();											// auto play gps track recording
			setTimeout(function() { brushed(true); }, 200);	// initialise position of brush

			return true;
		}
	};

} )();