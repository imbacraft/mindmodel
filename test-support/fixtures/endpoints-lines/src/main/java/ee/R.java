package ee;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

@Path("/rest")
public class R {

  @GET
  @Path("/a")
  public String get() {
    return "";
  }

  @POST
  public String post() {
    return "";
  }
}
