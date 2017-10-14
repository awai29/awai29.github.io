$(window).resize(function() {
	  jQuery(document).ready(function(){
		  var winWidth = jQuery(window).width();
		  if( winWidth > 751) {
			  $( "nav" ).show();
		  } else {
			  $( "nav" ).hide();
		  }
	  })
});

function nav_drop(){
		  var winWidth = jQuery(window).width();
		  if( winWidth > 751) {
			  $( "nav" ).show();
		  } else {
			  $( "nav" ).hide();
		  }			
}