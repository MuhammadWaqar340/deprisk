import { getUser } from "compat-pkg";
const user = getUser();
if (user) {
  console.log(user.name);
}
